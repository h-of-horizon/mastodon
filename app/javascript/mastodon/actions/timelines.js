import { Map as ImmutableMap, List as ImmutableList } from 'immutable';

import api, { getLinks } from 'mastodon/api';
import { compareId } from 'mastodon/compare_id';
import { usePendingItems as preferPendingItems } from 'mastodon/initial_state';

import { importFetchedStatus, importFetchedStatuses } from './importer';
import { submitMarkers } from './markers';
import { timelineDelete } from './timelines_typed';

export { disconnectTimeline } from './timelines_typed';

export const TIMELINE_UPDATE  = 'TIMELINE_UPDATE';
export const TIMELINE_CLEAR   = 'TIMELINE_CLEAR';
// Twitter 스타일 thread chain — 이미 timeline 안에 있는 ancestor 를 top 으로 이동
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

// Twitter 스타일 ancestor 인젝션 — 같은 ancestor 가 직전 N개 안에 있으면
// 다시 prepend 하지 않음 (sliding window dedup). 서버측 HomeFeed.rb 의
// ANCESTOR_DEDUP_WINDOW (5) 와 동일하게 유지.
const STREAMING_ANCESTOR_DEDUP_WINDOW = 5;
// chain walking 최대 깊이 — A→B1→...→Bn 깊은 chain 방어. 서버 MAX_CHAIN_DEPTH 와 동일.
const MAX_CHAIN_DEPTH = 8;

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

    // ─── 2단계: Twitter 스타일 chain 재배치 (multi-level) ───
    // 답글이 도착했을 때 (streaming 이든 사용자 본인 submitCompose 든)
    // 전체 chain (A → B1 → B2 → ... → reply) 을 reply 위쪽으로 chronological
    // 순서로 정렬. 서버측 HomeFeed.inject_ancestors 의 BFS 와 동일한 의도.
    //
    // 절차:
    //   1. statuses 스토어를 거슬러 올라가며 chain id 수집 (in_reply_to_id 따라)
    //   2. chain 의 각 id 를 INNERMOST(직속 parent) → OUTERMOST(root) 순으로 bump.
    //      각 bump 가 해당 id 를 items 의 top 으로 이동 → 마지막에 root 가 top
    //   3. chain walk 가 not-in-store ancestor 에서 멈췄으면 그 한 개만 API fetch.
    //      (더 깊은 ancestor 는 새로고침 시 서버측 BFS 가 채움 — recursive fetch 회피)
    if (timeline === 'home' && status.in_reply_to_id) {
      const pendingItems = getState().getIn(['timelines', timeline, 'pendingItems'], ImmutableList());
      const isPendingMode = preferPendingItems || !pendingItems.isEmpty();

      if (!isPendingMode) {
        const statuses = getState().get('statuses');

        // (1) chain walk — innermost(직속 parent) 부터 위로
        const chainIds = [];
        const visited = new Set([status.id]);
        let cursor = status.in_reply_to_id;
        let depth = 0;

        while (cursor && !visited.has(cursor) && depth < MAX_CHAIN_DEPTH) {
          visited.add(cursor);
          const ancestorInStore = statuses.get(cursor);
          if (!ancestorInStore) break; // 스토어에 없으면 chain walk 중단
          // DM ancestor 방어 — 서버 layer 가 race condition 등으로 새어도
          // 클라이언트가 추가 leak 차단. DM 은 home 에 절대 끌어올리지 않음.
          if (ancestorInStore.get('visibility') === 'direct') break;
          chainIds.push(cursor);
          cursor = ancestorInStore.get('in_reply_to_id');
          depth += 1;
        }
        // chainIds = [B1, A] (innermost → outermost) 같은 형태
        // cursor 가 여전히 truthy → chain 이 not-in-store ancestor 에서 멈춤

        // (2) chain bump — INNERMOST 먼저 (그래야 OUTERMOST 가 top 으로 마지막에 옴)
        chainIds.forEach((id) => {
          dispatch({
            type: TIMELINE_BUMP_TO_TOP,
            timeline,
            statusId: id,
          });
        });

        // (3) chain walk 가 미해결 ancestor 에서 멈췄으면 그것 한 개 fetch
        //     (예: 미팔로우 사용자의 답글 chain — 그 사람 글들이 스토어에 없음)
        if (cursor && depth < MAX_CHAIN_DEPTH) {
          try {
            const response = await api().get(`/api/v1/statuses/${cursor}`);
            const ancestor = response.data;
            // DM ancestor 방어 — fetch 응답이 DM 이면 home 에 끌어올리지 않음.
            // 서버 정책상 user 가 mention 된 DM 은 GET 으로 받을 수 있지만,
            // 우리 home 노출 정책은 DM 절대 표시 X.
            if (ancestor.visibility !== 'direct') {
              dispatch(importFetchedStatus(ancestor, { bogusQuotePolicy }));
              dispatch({
                type: TIMELINE_UPDATE,
                timeline,
                status: ancestor,
                usePendingItems: preferPendingItems,
              });
              // → items: [fetched_root, ...chain..., reply, ...]
            }
          } catch (err) {
            // 가시성 없음 (404/403) — chain 에 있는 거까지만 노출
          }
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
