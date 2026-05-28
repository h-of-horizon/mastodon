import { Map as ImmutableMap, List as ImmutableList, OrderedSet as ImmutableOrderedSet, fromJS } from 'immutable';


import {
  blockAccountSuccess,
  muteAccountSuccess,
  unfollowAccountSuccess
} from '../actions/accounts';
import {
  TIMELINE_UPDATE,
  TIMELINE_CLEAR,
  TIMELINE_EXPAND_SUCCESS,
  TIMELINE_EXPAND_REQUEST,
  TIMELINE_EXPAND_FAIL,
  TIMELINE_SCROLL_TOP,
  TIMELINE_CONNECT,
  TIMELINE_LOAD_PENDING,
  TIMELINE_MARK_AS_PARTIAL,
  TIMELINE_INSERT,
  TIMELINE_GAP,
  TIMELINE_BUMP_TO_TOP,
  disconnectTimeline,
} from '../actions/timelines';
import {
  timelineDelete,
  timelineDeleteStatus,
  isTimelineKeyPinned,
  isNonStatusId,
} from '../actions/timelines_typed';
import { compareId } from '../compare_id';

/** @type {ImmutableMap<string, typeof initialTimeline>} */
const initialState = ImmutableMap();

const initialTimeline = ImmutableMap({
  unread: 0,
  online: false,
  top: true,
  isLoading: false,
  hasMore: true,
  /** @type {ImmutableList<string>} */
  pendingItems: ImmutableList(),
  /** @type {ImmutableList<string>} */
  items: ImmutableList(),
});


const expandNormalizedTimeline = (state, timeline, statuses, next, isPartial, isLoadingRecent, usePendingItems) => {
  // This method is pretty tricky because:
  // - existing items in the timeline might be out of order
  // - the existing timeline may have gaps, most often explicitly noted with a `null` item
  // - ideally, we don't want it to reorder existing items of the timeline
  // - `statuses` may include items that are already included in the timeline
  // - this function can be called either to fill in a gap, or load newer items

  return state.update(timeline, initialTimeline, map => map.withMutations(mMap => {
    mMap.set('isLoading', false);
    mMap.set('isPartial', isPartial);

    if (!next && !isLoadingRecent) mMap.set('hasMore', false);

    if (isTimelineKeyPinned(timeline)) {
      mMap.set('items', statuses.map(status => status.get('id')));
    } else if (!statuses.isEmpty()) {
      usePendingItems = isLoadingRecent && (usePendingItems || !mMap.get('pendingItems').isEmpty());

      mMap.update(usePendingItems ? 'pendingItems' : 'items', ImmutableList(), oldIds => {
        const newIds = statuses.map(status => status.get('id'));

        // Now this gets tricky, as we don't necessarily know for sure where the gap to fill is
        // and some items in the timeline may not be properly ordered.

        // However, we know that `newIds.last()` is the oldest item that was requested and that
        // there is no “hole” between `newIds.last()` and `newIds.first()`.

        // First, find the furthest (if properly sorted, oldest) item in the timeline that is
        // newer than the oldest fetched one, as it's most likely that it delimits the gap.
        // Start the gap *after* that item.
        const lastIndex = oldIds.findLastIndex(id => !isNonStatusId(id) && compareId(id, newIds.last()) >= 0) + 1;

        // Then, try to find the furthest (if properly sorted, oldest) item in the timeline that
        // is newer than the most recent fetched one, as it delimits a section comprised of only
        // items older or within `newIds` (or that were deleted from the server, so should be removed
        // anyway).
        // Stop the gap *after* that item.
        const firstIndex = oldIds.take(lastIndex).findLastIndex(id => !isNonStatusId(id) && compareId(id, newIds.first()) > 0) + 1;

        let insertedIds = ImmutableOrderedSet(newIds).withMutations(insertedIds => {
          // It is possible, though unlikely, that the slice we are replacing contains items older
          // than the elements we got from the API. Get them and add them back at the back of the
          // slice.
          const olderIds = oldIds.slice(firstIndex, lastIndex).filter(id => !isNonStatusId(id) && compareId(id, newIds.last()) < 0);
          insertedIds.union(olderIds);

          // Make sure we aren't inserting duplicates
          insertedIds.subtract(oldIds.take(firstIndex), oldIds.skip(lastIndex));
        }).toList();

        // 폐쇄형 인스턴스 정책: partial 응답 시 TIMELINE_GAP unshift 비활성.
        // GAP marker 가 chain 시각 + 더보기 UX 혼란 유발 → 제거.
        // (서버측 async refresh 가 완료되면 자동 갱신되므로 GAP 없이도 일관성 유지)

        return oldIds.take(firstIndex).concat(
          insertedIds,
          oldIds.skip(lastIndex),
        );
      });
    }
  }));
};

const updateTimeline = (state, timeline, status, usePendingItems) => {
  const top = state.getIn([timeline, 'top']);

  if (usePendingItems || !state.getIn([timeline, 'pendingItems']).isEmpty()) {
    if (state.getIn([timeline, 'pendingItems'], ImmutableList()).includes(status.get('id')) || state.getIn([timeline, 'items'], ImmutableList()).includes(status.get('id'))) {
      return state;
    }

    return state.update(timeline, initialTimeline, map => map.update('pendingItems', list => list.unshift(status.get('id'))).update('unread', unread => unread + 1));
  }

  const ids        = state.getIn([timeline, 'items'], ImmutableList());
  const includesId = ids.includes(status.get('id'));
  const unread     = state.getIn([timeline, 'unread'], 0);

  if (includesId) {
    return state;
  }

  let newIds = ids;

  return state.update(timeline, initialTimeline, map => map.withMutations(mMap => {
    if (!top) mMap.set('unread', unread + 1);
    if (top && ids.size > 40) newIds = newIds.take(20);
    mMap.set('items', newIds.unshift(status.get('id')));
  }));
};

const deleteStatus = (state, id, references, exclude_account = null) => {
  state.keySeq().forEach(timeline => {
    if (exclude_account === null || (timeline !== `account:${exclude_account}` && !timeline.startsWith(`account:${exclude_account}:`))) {
      const helper = list => list.filterNot(item => item === id);
      state = state.updateIn([timeline, 'items'], helper).updateIn([timeline, 'pendingItems'], helper);
    }
  });

  // Remove reblogs of deleted status
  references.forEach(ref => {
    state = deleteStatus(state, ref, [], exclude_account);
  });

  return state;
};

const deleteStatusFromTimeline = (state, statusId, timelineKey) => {
  const helper = list => list.filterNot((status) => status === statusId);
  return state.updateIn([timelineKey, 'items'], helper).updateIn([timelineKey, 'pendingItems'], helper);
}

const clearTimeline = (state, timeline) => {
  return state.set(timeline, initialTimeline);
};

const filterTimelines = (state, relationship, statuses) => {
  let references;

  statuses.forEach(status => {
    if (status.get('account') !== relationship.id) {
      return;
    }

    references = statuses.filter(item => item.get('reblog') === status.get('id')).map(item => item.get('id')).valueSeq().toJSON();
    state      = deleteStatus(state, status.get('id'), references, relationship.id);
  });

  return state;
};

const filterTimeline = (timeline, state, relationship, statuses) => {
  const helper = list => list.filterNot(statusId => statuses.getIn([statusId, 'account']) === relationship.id);
  return state.updateIn([timeline, 'items'], ImmutableList(), helper).updateIn([timeline, 'pendingItems'], ImmutableList(), helper);
};

const updateTop = (state, timeline, top) => {
  return state.update(timeline, initialTimeline, map => map.withMutations(mMap => {
    if (top) mMap.set('unread', mMap.get('pendingItems').size);
    mMap.set('top', top);
  }));
};

const reconnectTimeline = (state, _usePendingItems) => {
  if (state.get('online')) {
    return state;
  }

  // 폐쇄형 인스턴스 정책: streaming reconnect 시 TIMELINE_GAP 마커 unshift 비활성.
  // GAP 가 chain 시각을 깨고 ("더보기" 가 timeline 처음에 등장) "더보기 오류" 호소 유발.
  // streaming 갱신은 자동 (TIMELINE_UPDATE) 으로 처리되므로 GAP 필요 없음.
  return state.set('online', true);
};

/** @type {import('@reduxjs/toolkit').Reducer<typeof initialState>} */
export default function timelines(state = initialState, action) {
  switch(action.type) {
  case TIMELINE_LOAD_PENDING:
    return state.update(action.timeline, initialTimeline, map =>
      map.update('items', list => map.get('pendingItems').concat(list.take(40))).set('pendingItems', ImmutableList()).set('unread', 0));
  case TIMELINE_EXPAND_REQUEST:
    return state.update(action.timeline, initialTimeline, map => map.set('isLoading', true));
  case TIMELINE_EXPAND_FAIL:
    return state.update(action.timeline, initialTimeline, map => map.set('isLoading', false));
  case TIMELINE_EXPAND_SUCCESS:
    return expandNormalizedTimeline(state, action.timeline, fromJS(action.statuses), action.next, action.partial, action.isLoadingRecent, action.usePendingItems);
  case TIMELINE_UPDATE:
    return updateTimeline(state, action.timeline, fromJS(action.status), action.usePendingItems);
  case TIMELINE_BUMP_TO_TOP:
    // 직속 부모 inject — streaming 도착 답글의 직속 부모를 items 의 top 으로 이동.
    // status 스토어는 건드리지 않고 timeline.items 리스트의 순서만 변경.
    return state.updateIn([action.timeline, 'items'], ImmutableList(), items =>
      items.filterNot(id => id === action.statusId).unshift(action.statusId),
    );
  case TIMELINE_CLEAR:
    return clearTimeline(state, action.timeline);
  case TIMELINE_SCROLL_TOP:
    return updateTop(state, action.timeline, action.top);
  case TIMELINE_CONNECT:
    return state.update(action.timeline, initialTimeline, map => reconnectTimeline(map, action.usePendingItems));
  case TIMELINE_MARK_AS_PARTIAL:
    return state.update(
      action.timeline,
      initialTimeline,
      map => map.set('isPartial', true).set('items', ImmutableList()).set('pendingItems', ImmutableList()).set('unread', 0),
    );
  case TIMELINE_INSERT:
    return state.update(
      action.timeline,
      initialTimeline,
      map => map.update('items', ImmutableList(), list => {
        if (!list.includes(action.key)) {
          return list.insert(action.index, action.key);
        }

        return list;
      })
    );
  default:
    if (timelineDelete.match(action)) {
      return deleteStatus(state, action.payload.statusId, action.payload.references, action.payload.reblogOf);
    } else if (timelineDeleteStatus.match(action)) {
      return deleteStatusFromTimeline(state, action.payload.statusId, action.payload.timelineKey);
    } else if (blockAccountSuccess.match(action) || muteAccountSuccess.match(action)) {
      return filterTimelines(state, action.payload.relationship, action.payload.statuses);
    } else if (unfollowAccountSuccess.match(action)) {
      return filterTimeline('home', state, action.payload.relationship, action.payload.statuses);
    } else if (disconnectTimeline.match(action)) {
      // 폐쇄형 인스턴스 정책: streaming disconnect 시 TIMELINE_GAP unshift 비활성.
      // GAP 가 timeline 처음에 "더보기" 버튼으로 노출되어 chain 시각 + 더보기 UX 혼란 유발.
      return state.update(
        action.payload.timeline,
        initialTimeline,
        (map) => map.set('online', false),
      );
    }

    return state;
  }
}
