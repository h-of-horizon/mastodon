import { useCallback } from 'react';

import { FormattedMessage } from 'react-intl';

import { useHistory } from 'react-router-dom';

import { useAppSelector } from 'mastodon/store';

// Twitter 식 "Show this thread" link — 답글 카드 아래에 표시되어 사용자가 chain 전체를
// 상세 페이지에서 확인할 수 있도록 안내.
//
// 표시 조건 (status_quoted.tsx 에서 검사):
//   • contextType === 'home'
//   • status.in_reply_to_id 가 있음 (답글)
//   • 직속 부모가 home timeline 의 items 에 없음 (즉 home_feed.rb 가 inject 안 했거나
//     사용자가 직속 부모 안 받는 상태)
//
// 클릭 동작: 답글 자체의 상세 페이지로 이동 → mastodon context API 가 ancestors 전체 표시.

interface Props {
  statusId: string;
}

export const ShowThreadLink: React.FC<Props> = ({ statusId }) => {
  const history = useHistory();

  const statusAcct = useAppSelector((state) => {
    const status = state.statuses.get(statusId);
    if (!status) return null;
    const accountRef = status.get('account');
    const accountId =
      typeof accountRef === 'string' ? accountRef : accountRef?.get?.('id');
    if (!accountId) return null;
    return state.accounts.get(accountId)?.acct ?? null;
  });

  const handleClick = useCallback(() => {
    if (statusAcct) {
      history.push(`/@${statusAcct}/${statusId}`);
    }
  }, [history, statusAcct, statusId]);

  if (!statusAcct) return null;

  return (
    <button
      type='button'
      className='show-thread-link'
      onClick={handleClick}
    >
      <FormattedMessage
        id='status.show_thread'
        defaultMessage='이어지는 글타래 보기'
      />
    </button>
  );
};
