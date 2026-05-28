import { Map as ImmutableMap, List as ImmutableList } from 'immutable';

import api, { getLinks } from 'mastodon/api';
import { compareId } from 'mastodon/compare_id';
import { usePendingItems as preferPendingItems, me } from 'mastodon/initial_state';

import { importFetchedStatus, importFetchedStatuses } from './importer';
import { submitMarkers } from './markers';
import { timelineDelete } from './timelines_typed';

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

// Chain walk 헬퍼 — store 의 statuses 따라 root 까지 추적, root + immediate-child 식별.
// immediate-child = root 의 직속 답글 (root 의 다음 element). statusId 가 root 이면 immediate = statusId 자기.
const findChainInfo = (statusId, storeStatuses, maxDepth = 50) => {
  let cursor = statusId;
  let previousCursor = null;
  const visited = new Set();
  let depth = 0;
  while (cursor && !visited.has(cursor) && depth < maxDepth) {
    visited.add(cursor);
    const s = storeStatuses.get(cursor);
    if (!s) return { rootId: cursor, immediateChildId: previousCursor || statusId };
    const parentId = s.get('in_reply_to_id');
    if (!parentId) return { rootId: cursor, immediateChildId: previousCursor || statusId };
    previousCursor = cursor;
    cursor = parentId;
    depth += 1;
  }
  return { rootId: cursor, immediateChildId: previousCursor || statusId };
};

// Streaming 새 답글용 — status 자기는 store 에 없으므로 parentId 부터 walk.
// previousCursor 초기값이 status 자기 (root 의 직속 답글 case).
const findChainInfoFromParent = (parentId, currentId, storeStatuses, maxDepth = 50) => {
  let cursor = parentId;
  let previousCursor = currentId;
  const visited = new Set([currentId]);
  let depth = 0;
  while (cursor && !visited.has(cursor) && depth < maxDepth) {
    visited.add(cursor);
    const s = storeStatuses.get(cursor);
    if (!s) return { rootId: cursor, immediateChildId: previousCursor };
    const nextParent = s.get('in_reply_to_id');
    if (!nextParent) return { rootId: cursor, immediateChildId: previousCursor };
    previousCursor = cursor;
    cursor = nextParent;
    depth += 1;
  }
  return { rootId: cursor, immediateChildId: previousCursor };
};

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

    // 평행 답글 정리 — 트위터 식 "원글당 답글 chain 하나"
    //
    // 검사: 새 답글의 chain root + immediate-child (root 의 직속 답글) 식별 후
    //       items 의 다른 status 중 같은 root + 다른 immediate-child 가 있으면 평행 답글 → 무시.
    //
    // 예외: 본인 답글 (status.account.id === me) 은 항상 통과 — 사용자가 자기 답글
    //       작성 후 본인 화면에 안 나타나는 어색한 UX 방지.
    //
    // 알고리즘: chain walk 으로 root 까지 따라감. depth 1 (직속 in_reply_to_id) 만 검사
    //          하던 이전 단순 방식의 한계 (깊은 chain leaf 가 평행 답글로 분류 안 됨)
    //          를 해결. store 의 statuses 따라 walk — 비용은 timeline 크기 × depth 정도라 미미.
    if (timeline === 'home' && status.in_reply_to_id && status.account?.id !== me) {
      const items = getState().getIn(['timelines', 'home', 'items'], ImmutableList());
      const storeStatuses = getState().get('statuses');

      // 새 답글의 chain 정보 (store 에 없으므로 in_reply_to_id 부터 walk)
      const newInfo = findChainInfoFromParent(status.in_reply_to_id, status.id, storeStatuses);

      // items 의 각 status 의 chain 정보 비교 — 같은 root + 다른 immediate-child = 평행
      const parallelExists = items.some(id => {
        if (typeof id !== 'string' || id === status.id) return false;
        const info = findChainInfo(id, storeStatuses);
        return info && info.rootId === newInfo.rootId && info.immediateChildId !== newInfo.immediateChildId;
      });

      if (parallelExists) return;
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

      if (timelineId === 'home' && !isLoadingMore && !isLoadingRecent) {
        const now = new Date();
        const fittingIndex = response.data.findIndex(status => now - (new Date(status.created_at)) > 4 * 3600 * 1000);

        if (fittingIndex !== -1) {
          dispatch(insertIntoTimeline(timelineId, TIMELINE_SUGGESTIONS, Math.max(1, fittingIndex)));
        }
      }

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
