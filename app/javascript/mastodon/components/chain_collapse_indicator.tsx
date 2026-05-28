import { useCallback } from 'react';

import { FormattedMessage } from 'react-intl';

import { useHistory } from 'react-router-dom';

import { useAppSelector } from 'mastodon/store';

// Twitter 식 thread 압축 표시 — root 와 가장 최신 답글 사이에 표시되는 작은 버튼.
//
// home_feed.rb 의 build_chain 이 깊은 chain (A → B1 → ... → B111) 을 [A, B111] 로
// 압축 반환할 때, 사용자가 중간 답글이 생략되었음을 인지하고 root status 의 상세
// 페이지로 진입하여 전체 chain 을 확인할 수 있도록 안내.
//
// 시각: 가는 thread line + "더 많은 답글 보기" 텍스트 — 카드 사이에 자연스럽게 녹아듦.
// 클릭: root status 의 상세 페이지 (/@acct/statusId) 로 이동.

interface Props {
  rootId: string;
}

export const ChainCollapseIndicator: React.FC<Props> = ({ rootId }) => {
  const history = useHistory();

  const rootAcct = useAppSelector((state) => {
    const status = state.statuses.get(rootId);
    if (!status) return null;
    const accountRef = status.get('account');
    const accountId =
      typeof accountRef === 'string' ? accountRef : accountRef?.get?.('id');
    if (!accountId) return null;
    return state.accounts.get(accountId)?.acct ?? null;
  });

  const handleClick = useCallback(() => {
    if (rootAcct) {
      history.push(`/@${rootAcct}/${rootId}`);
    }
  }, [history, rootAcct, rootId]);

  // rootAcct 가 store 에 없으면 클릭해도 이동 불가 → disabled 로 표시하여 silent fail
  // 방지. 사용자가 페이지를 새로고침하면 root 의 account 정보가 다시 로드되어 활성화됨.
  const disabled = !rootAcct;

  return (
    <button
      type='button'
      className='chain-collapse-indicator'
      onClick={handleClick}
      disabled={disabled}
      aria-disabled={disabled}
    >
      <span className='chain-collapse-indicator__line' aria-hidden='true' />
      <span className='chain-collapse-indicator__label'>
        <FormattedMessage
          id='thread.show_more_replies'
          defaultMessage='더 많은 답글 보기'
        />
      </span>
    </button>
  );
};
