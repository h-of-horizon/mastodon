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
// Twitter 식 thread 압축 — 중간 답글을 timeline items/pendingItems 에서 제거.
// status entity 자체는 store 에 유지하여 상세 페이지/알림 등 다른 참조처가 영향받지 않음.
export const TIMELINE_PRUNE = 'TIMELINE_PRUNE';

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
// chain walking 최대 깊이 — 서버 home_feed.rb 의 MAX_CHAIN_DEPTH 와 동일하게 유지.
// 100+ 단계 chain 도 root 까지 walk 가능 (실무에서는 store 의 statuses 가 부족해
// 일찍 멈추는 경우가 대부분이라 client 측 비용은 평상시 미미).
const MAX_CHAIN_DEPTH = 200;

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

    // ─── 2단계: Twitter 식 thread 압축 ───
    // 답글이 도착했을 때 (streaming 이든 사용자 본인 submitCompose 든)
    // chain (A → B1 → B2 → ... → reply) 에서 root(A) 만 reply 위로 끌어오고,
    // 중간 답글(B1, B2, ...) 은 timeline 에서 제거 → 결과 [A, reply].
    // 서버측 HomeFeed.build_chain 의 [root, status] 압축과 동일 의도.
    //
    // 절차:
    //   1. statuses 스토어를 거슬러 올라가며 chain id 수집 (in_reply_to_id 따라)
    //      — 마지막에 발견된 ancestor 가 root, 나머지는 중간 답글
    //   2. 중간 답글들은 TIMELINE_PRUNE 으로 timeline items 에서 제거
    //      (status entity 는 store 에 유지 → 상세 페이지/알림 등 영향 없음)
    //   3. root 만 TIMELINE_BUMP_TO_TOP 으로 items 의 top 으로 이동
    //   4. chain walk 가 not-in-store ancestor 에서 멈췄으면 그것을 한 번 fetch.
    //      fetch 응답이 chain root (in_reply_to_id 없음) 일 때만 timeline 추가.
    //      중간 답글이면 추가하지 않음 (서버 압축 정책과 일치).
    if (timeline === 'home' && status.in_reply_to_id) {
      const pendingItems = getState().getIn(['timelines', timeline, 'pendingItems'], ImmutableList());
      const isPendingMode = preferPendingItems || !pendingItems.isEmpty();

      if (!isPendingMode) {
        const statuses = getState().get('statuses');

        // (1) chain walk — innermost(직속 parent) 부터 위로, root 까지
        const visited = new Set([status.id]);
        let cursor = status.in_reply_to_id;
        let depth = 0;
        let rootId = null;
        const middleIds = []; // chain 중간 답글 (root 가 아닌 ancestor)

        while (cursor && !visited.has(cursor) && depth < MAX_CHAIN_DEPTH) {
          visited.add(cursor);
          const ancestorInStore = statuses.get(cursor);
          if (!ancestorInStore) break; // 스토어에 없으면 chain walk 중단
          // DM ancestor 방어 — 서버 layer 가 race condition 등으로 새어도
          // 클라이언트가 추가 leak 차단. DM 은 home 에 절대 끌어올리지 않음.
          if (ancestorInStore.get('visibility') === 'direct') break;

          // 이전에 root 후보로 잡았던 id 가 새 ancestor 발견으로 중간 답글로 밀림
          if (rootId !== null) {
            middleIds.push(rootId);
          }
          rootId = cursor;
          cursor = ancestorInStore.get('in_reply_to_id');
          depth += 1;
        }
        // cursor 가 여전히 truthy → chain 이 not-in-store ancestor 에서 멈춤
        // rootId 도 truthy 라면 시점상 잠정적 root (store 가 chain 끝까지 못 따라간 경우)

        // (2) 중간 답글 prune — timeline items 에서만 제거 (status entity 는 유지)
        if (middleIds.length > 0) {
          dispatch({
            type: TIMELINE_PRUNE,
            timeline,
            statusIds: middleIds,
          });
        }

        // (3) root 만 top 으로 BUMP — reply 위에 chain root 만 표시
        if (rootId) {
          dispatch({
            type: TIMELINE_BUMP_TO_TOP,
            timeline,
            statusId: rootId,
          });
        }

        // (4) chain walk 가 미해결 ancestor 에서 멈췄으면 그것 한 개 fetch.
        //     fetch 응답이 chain root (in_reply_to_id 없음) 일 때만 추가.
        //     중간 답글이면 timeline 노출 안 함 (서버 정책 [root, reply] 와 일치).
        //     사용자 새로고침 시 서버측 inject_ancestors 가 root 까지 정확히 채움.
        if (cursor && depth < MAX_CHAIN_DEPTH) {
          try {
            const response = await api().get(`/api/v1/statuses/${cursor}`);
            const ancestor = response.data;
            if (ancestor.visibility !== 'direct' && !ancestor.in_reply_to_id) {
              // fetch 한 ancestor 가 chain root → timeline 에 prepend
              dispatch(importFetchedStatus(ancestor, { bogusQuotePolicy }));
              dispatch({
                type: TIMELINE_UPDATE,
                timeline,
                status: ancestor,
                usePendingItems: preferPendingItems,
              });
            }
            // root 가 아니면 (중간 답글) timeline 노출 안 함 — Twitter 식 압축
          } catch (err) {
            // 가시성 없음 (404/403) — chain 압축 결과만 노출
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
