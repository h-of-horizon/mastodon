import { Map as ImmutableMap, List as ImmutableList } from 'immutable';

import api, { getLinks } from 'mastodon/api';
import { compareId } from 'mastodon/compare_id';
import { usePendingItems as preferPendingItems, me } from 'mastodon/initial_state';

import { importFetchedStatus, importFetchedStatuses } from './importer';
import { submitMarkers } from './markers';
import { timelineDelete, timelineDeleteStatus } from './timelines_typed';

export { disconnectTimeline } from './timelines_typed';

export const TIMELINE_UPDATE  = 'TIMELINE_UPDATE';
export const TIMELINE_CLEAR   = 'TIMELINE_CLEAR';
// 직속 부모 inject — streaming 으로 도착한 답글의 직속 부모를 답글 위로 BUMP.
// chain compress / 중간 prune 폐기 (이전 정책). 깊은 chain 추적 안 함.
export const TIMELINE_BUMP_TO_TOP = 'TIMELINE_BUMP_TO_TOP';

export const TIMELINE_EXPAND_REQUEST = 'TIMELINE_EXPAND_REQUEST';
export const TIMELINE_EXPAND_SUCCESS = 'TIMELINE_EXPAND_SUCCESS';
export const TIMELINE_EXPAND_FAIL    = 'TIMELINE_EXPAND_FAIL';

export const TIMELINE_SCROLL_TOP   = 'TIMELINE_SCROLL_TOP';
export const TIMELINE_LOAD_PENDING = 'TIMELINE_LOAD_PENDING';
export const TIMELINE_CONNECT      = 'TIMELINE_CONNECT';

export const TIMELINE_MARK_AS_PARTIAL = 'TIMELINE_MARK_AS_PARTIAL';
export const TIMELINE_INSERT          = 'TIMELINE_INSERT';

// When adding new special markers here, make sure to update TIMELINE_NON_STATUS_MARKERS in actions/timelines_typed.js
export const TIMELINE_SUGGESTIONS = 'inline-follow-suggestions';
export const TIMELINE_GAP = null;
export const TIMELINE_PINNED_VIEW_ALL = 'pinned-view-all';

export const TIMELINE_NON_STATUS_MARKERS = [
  TIMELINE_GAP,
  TIMELINE_SUGGESTIONS,
  TIMELINE_PINNED_VIEW_ALL,
];

export const loadPending = timeline => ({
  type: TIMELINE_LOAD_PENDING,
  timeline,
});

export function updateTimeline(timeline, status, { accept = undefined, bogusQuotePolicy = false } = {}) {
  return async (dispatch, getState) => {
    if (typeof accept === 'function' && !accept(status)) {
      return;
    }

    if (getState().getIn(['timelines', timeline, 'isPartial'])) {
      // Prevent new items from being added to a partial timeline,
      // since it will be reloaded anyway
      return;
    }

    // 폐쇄형 인스턴스 정책: 홈 타임라인에 DM 절대 노출 X.
    // 서버측 FeedManager.filter_from_home + HomeFeed.get 가 차단하지만,
    // streaming 으로 직접 들어오는 경우 대비해 클라이언트에서도 한 번 더 막음.
    if (timeline === 'home' && status.visibility === 'direct') {
      return;
    }

    // 추가 방어: DM 의 답글(부모가 direct visibility)도 home 차단.
    // 서버 Layer 1/2 가 막지만 race condition 보호.
    if (timeline === 'home' && status.in_reply_to_id) {
      const parentInStore = getState().getIn(['statuses', status.in_reply_to_id]);
      if (parentInStore && parentInStore.get('visibility') === 'direct') {
        return;
      }
    }

    // 평행 답글 정리 — 트위터 식 "같은 부모의 답글은 하나만" + 본인 답글 우선
    //
    // 정책:
    //   • 다른 사람 답글: 같은 in_reply_to_id 의 답글이 timeline 에 이미 있으면 무시
    //     (기존 답글 유지, 새 답글 dispatch 안 함)
    //   • 본인 답글 (status.account.id === me): 같은 in_reply_to_id 의 timeline 답글
    //     들을 모두 **제거** 한 뒤 본인 답글 추가. 본인 답글이 다른 답글보다 우선.
    //
    // Self-thread 영향 없음: A→B→B1→B2 의 각 status 는 모두 다른 direct parent
    //                       (B.parent=A, B1.parent=B, B2.parent=B1) → 모두 통과.
    if (timeline === 'home' && status.in_reply_to_id) {
      const items = getState().getIn(['timelines', 'home', 'items'], ImmutableList());
      const storeStatuses = getState().get('statuses');

      // 같은 in_reply_to_id 의 timeline 답글들 식별
      const parallelIds = items.filter(id => {
        if (typeof id !== 'string' || id === status.id) return false;
        const s = storeStatuses.get(id);
        return s && s.get('in_reply_to_id') === status.in_reply_to_id;
      });

      if (parallelIds.size > 0) {
        if (status.account?.id === me) {
          // 본인 답글 — 시간 비교 후 본인 답글이 더 newer 일 때만 기존 답글 제거.
          // 일반적으로 본인 답글이 작성 즉시 streaming 도착이라 newest 이지만,
          // 서버 지연 / 다른 사람의 newer 답글이 먼저 도착한 경우 본인 답글을
          // 강제 우선 처리하면 시간순 어색. created_at 비교로 정확한 시간순 보장.
          const newStatusTime = new Date(status.created_at).getTime();
          parallelIds.forEach(id => {
            const existing = storeStatuses.get(id);
            if (!existing) return;
            const existingTime = new Date(existing.get('created_at')).getTime();
            // 본인 답글이 같거나 더 newer 면 기존 제거. older 면 그대로 유지.
            if (newStatusTime >= existingTime) {
              dispatch(timelineDeleteStatus({ statusId: id, timelineKey: timeline }));
            }
          });

          // 본인 답글이 모든 기존 답글보다 older 면 추가 안 함 (시간순)
          const allExistingNewer = parallelIds.every(id => {
            const existing = storeStatuses.get(id);
            return existing && new Date(existing.get('created_at')).getTime() > newStatusTime;
          });
          if (allExistingNewer) return;
        } else {
          // 다른 사람 답글 — 평행 답글 이미 있으면 무시
          return;
        }
      }
    }

    // ─── 1단계: reply 본체를 timeline 의 top 에 추가 ───
    dispatch(importFetchedStatus(status, { bogusQuotePolicy }));

    dispatch({
      type: TIMELINE_UPDATE,
      timeline,
      status,
      usePendingItems: preferPendingItems,
    });

    if (timeline === 'home') {
      dispatch(submitMarkers());
    }

    // ─── 2단계: 직속 부모만 BUMP (chain compress 폐기) ───
    // streaming 으로 도착한 답글의 직속 부모 (in_reply_to_id) 가 store 에 있고
    // home timeline 의 items 에 있으면 그것을 top 으로 이동 — 답글 바로 위에 위치.
    // 깊은 chain 추적 / 중간 답글 prune / "더 많은 답글 보기" indicator 모두 폐기.
    // 직속 부모가 없거나 store 에 없으면 답글 카드 자체의 'ㅇㅇ님에게' prepend 가
    // 컨텍스트 제공 (mastodon base 동작).
    if (timeline === 'home' && status.in_reply_to_id) {
      const pendingItems = getState().getIn(['timelines', timeline, 'pendingItems'], ImmutableList());
      const isPendingMode = preferPendingItems || !pendingItems.isEmpty();

      if (!isPendingMode) {
        const parentId = status.in_reply_to_id;
        const parentInStore = getState().getIn(['statuses', parentId]);

        // DM 부모 방어 — race condition 등으로 새도 home 에 절대 끌어올리지 않음
        if (parentInStore && parentInStore.get('visibility') !== 'direct') {
          dispatch({
            type: TIMELINE_BUMP_TO_TOP,
            timeline,
            statusId: parentId,
          });
        }
      }
    }
  };
}

export function deleteFromTimelines(id) {
  return (dispatch, getState) => {
    const accountId  = getState().getIn(['statuses', id, 'account']);
    const references = getState().get('statuses').filter(status => status.get('reblog') === id).map(status => status.get('id')).valueSeq().toJSON();
    const reblogOf   = getState().getIn(['statuses', id, 'reblog'], null);

    dispatch(timelineDelete({ statusId: id, accountId, references, reblogOf }));
  };
}

export function clearTimeline(timeline) {
  return (dispatch) => {
    dispatch({ type: TIMELINE_CLEAR, timeline });
  };
}

const parseTags = (tags = {}, mode) => {
  return (tags[mode] || []).map((tag) => {
    return tag.value;
  });
};

export function expandTimeline(timelineId, path, params = {}) {
  return async (dispatch, getState) => {
    const timeline = getState().getIn(['timelines', timelineId], ImmutableMap());
    const isLoadingMore = !!params.max_id;

    if (timeline.get('isLoading')) {
      return;
    }

    if (!params.max_id && !params.pinned && (timeline.get('items', ImmutableList()).size + timeline.get('pendingItems', ImmutableList()).size) > 0) {
      const a = timeline.getIn(['pendingItems', 0]);
      const b = timeline.getIn(['items', 0]);

      if (a && b && compareId(a, b) > 0) {
        params.since_id = a;
      } else {
        params.since_id = b || a;
      }
    }

    const isLoadingRecent = !!params.since_id;

    dispatch(expandTimelineRequest(timelineId, isLoadingMore));

    try {
      const response = await api().get(path, { params });
      const next = getLinks(response).refs.find(link => link.rel === 'next');

      dispatch(importFetchedStatuses(response.data));
      dispatch(expandTimelineSuccess(timelineId, response.data, next ? next.uri : null, response.status === 206, isLoadingRecent, isLoadingMore, isLoadingRecent && preferPendingItems));

      // 폐쇄형 인스턴스 정책: TIMELINE_SUGGESTIONS (inline-follow-suggestions) inject 비활성화.
      // 4시간 이상 오래된 status 위치에 follow 추천 카드 inject 했으나 chain 사이에 끼어
      // 시각 깨짐. 폐쇄형 한국어 인스턴스에서 follow 추천 자체 불필요.
      // (TIMELINE_SUGGESTIONS export 자체는 유지 — 다른 곳에서 import 가능하지만 dispatch X)

      if (timelineId === 'home') {
        dispatch(submitMarkers());
      }
    } catch(error) {
      dispatch(expandTimelineFail(timelineId, error, isLoadingMore));
    }
  };
}

export function fillTimelineGaps(timelineId, path, params = {}) {
  return async (dispatch, getState) => {
    const timeline = getState().getIn(['timelines', timelineId], ImmutableMap());
    const items = timeline.get('items');
    const nullIndexes = items.map((statusId, index) => statusId === null ? index : null);
    const gaps = nullIndexes.map(index => index > 0 ? items.get(index - 1) : null);

    // Only expand at most two gaps to avoid doing too many requests
    for (const maxId of gaps.take(2)) {
      await dispatch(expandTimeline(timelineId, path, { ...params, maxId }));
    }
  };
}

export const expandHomeTimeline            = ({ maxId } = {}) => expandTimeline('home', '/api/v1/timelines/home', { max_id: maxId });
export const expandPublicTimeline          = ({ maxId, onlyMedia, onlyRemote } = {}) => expandTimeline(`public${onlyRemote ? ':remote' : ''}${onlyMedia ? ':media' : ''}`, '/api/v1/timelines/public', { remote: !!onlyRemote, max_id: maxId, only_media: !!onlyMedia });
export const expandCommunityTimeline       = ({ maxId, onlyMedia } = {}) => expandTimeline(`community${onlyMedia ? ':media' : ''}`, '/api/v1/timelines/public', { local: true, max_id: maxId, only_media: !!onlyMedia });
export const expandAccountTimeline         = (accountId, { maxId, withReplies, tagged } = {}) => expandTimeline(`account:${accountId}${withReplies ? ':with_replies' : ''}${tagged ? `:${tagged}` : ''}`, `/api/v1/accounts/${accountId}/statuses`, { exclude_replies: !withReplies, exclude_reblogs: withReplies, tagged, max_id: maxId });
export const expandAccountFeaturedTimeline = (accountId, { tagged } = {}) => expandTimeline(`account:${accountId}:pinned${tagged ? `:${tagged}` : ''}`, `/api/v1/accounts/${accountId}/statuses`, { pinned: true, tagged });
export const expandAccountMediaTimeline    = (accountId, { maxId, withReplies } = {}) => expandTimeline(`account:${accountId}:media${withReplies ? ':with_replies' : ''}`, `/api/v1/accounts/${accountId}/statuses`, { max_id: maxId, only_media: true, limit: 40, exclude_replies: !withReplies });
export const expandListTimeline            = (id, { maxId } = {}) => expandTimeline(`list:${id}`, `/api/v1/timelines/list/${id}`, { max_id: maxId });
export const expandLinkTimeline            = (url, { maxId } = {}) => expandTimeline(`link:${url}`, `/api/v1/timelines/link`, { url, max_id: maxId });
export const expandHashtagTimeline         = (hashtag, { maxId, tags, local } = {}) => {
  return expandTimeline(`hashtag:${hashtag}${local ? ':local' : ''}`, `/api/v1/timelines/tag/${hashtag}`, {
    max_id: maxId,
    any:    parseTags(tags, 'any'),
    all:    parseTags(tags, 'all'),
    none:   parseTags(tags, 'none'),
    local:  local,
  });
};

export const fillHomeTimelineGaps      = () => fillTimelineGaps('home', '/api/v1/timelines/home', {});
export const fillPublicTimelineGaps    = ({ onlyMedia, onlyRemote } = {}) => fillTimelineGaps(`public${onlyRemote ? ':remote' : ''}${onlyMedia ? ':media' : ''}`, '/api/v1/timelines/public', { remote: !!onlyRemote, only_media: !!onlyMedia });
export const fillCommunityTimelineGaps = ({ onlyMedia } = {}) => fillTimelineGaps(`community${onlyMedia ? ':media' : ''}`, '/api/v1/timelines/public', { local: true, only_media: !!onlyMedia });
export const fillListTimelineGaps      = (id) => fillTimelineGaps(`list:${id}`, `/api/v1/timelines/list/${id}`, {});

export function expandTimelineRequest(timeline, isLoadingMore) {
  return {
    type: TIMELINE_EXPAND_REQUEST,
    timeline,
    skipLoading: !isLoadingMore,
  };
}

export function expandTimelineSuccess(timeline, statuses, next, partial, isLoadingRecent, isLoadingMore, usePendingItems) {
  return {
    type: TIMELINE_EXPAND_SUCCESS,
    timeline,
    statuses,
    next,
    partial,
    isLoadingRecent,
    usePendingItems,
    skipLoading: !isLoadingMore,
  };
}

export function expandTimelineFail(timeline, error, isLoadingMore) {
  return {
    type: TIMELINE_EXPAND_FAIL,
    timeline,
    error,
    skipLoading: !isLoadingMore,
    skipNotFound: timeline.startsWith('account:'),
  };
}

export function scrollTopTimeline(timeline, top) {
  return {
    type: TIMELINE_SCROLL_TOP,
    timeline,
    top,
  };
}

export function connectTimeline(timeline) {
  return {
    type: TIMELINE_CONNECT,
    timeline,
    usePendingItems: preferPendingItems,
  };
}

export const markAsPartial = timeline => ({
  type: TIMELINE_MARK_AS_PARTIAL,
  timeline,
});

export const insertIntoTimeline = (timeline, key, index) => ({
  type: TIMELINE_INSERT,
  timeline,
  index,
  key,
});
