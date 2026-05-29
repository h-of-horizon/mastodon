import { useCallback } from 'react';

import { FormattedMessage } from 'react-intl';

import { useHistory } from 'react-router-dom';

import { useAppSelector } from 'mastodon/store';

// Twitter X 식 "더 많은 답글 보기" indicator (정확 정합).
//
// 트위터 X 실제 DOM 기반 시각:
//   • 위치: root 카드와 leaf 카드 사이 별도 cell (article 외부, 카드 안 아님)
//   • 시각: 좌측 avatar column 위치에 점 3개 (vertical dots) + 우측 brand color 텍스트
//   • 클릭: chain root 의 상세 페이지 (/@{root_acct}/{root_id}) 로 이동
//
// 표시 조건은 status_quoted.tsx 의 chainCollapseInfo 가 결정:
//   • 답글의 in_reply_to_id 가 home timeline 에 없을 때 (직접 부모 안 보임 = chain compress)
//
// rootId props — 서버측 home_feed.rb 의 chain compress 결과 leaf 직전에 inject 된
// chain root 의 id. status_quoted 에서 timeline 의 자기 직전 item 으로 추출.
interface Props {
  rootId: string;
}

export const ChainCollapseIndicator: React.FC<Props> = ({ rootId }) => {
  const history = useHistory();

  const rootAcct = useAppSelector((state) => {
    const status = state.statuses.get(rootId);
    if (!status) return null;

    const accountRef = status.get('account');
    let accountId: string | null = null;

    if (typeof accountRef === 'string') {
      accountId = accountRef;
    } else if (
      accountRef &&
      typeof (accountRef as { id?: string }).id === 'string'
    ) {
      accountId = (accountRef as { id: string }).id;
    } else if (
      accountRef &&
      typeof (accountRef as { get?: unknown }).get === 'function'
    ) {
      accountId =
        (
          accountRef as unknown as {
            get: (k: string) => string | undefined;
          }
        ).get('id') ?? null;
    }

    if (!accountId) return null;
    return state.accounts.get(accountId)?.acct ?? null;
  });

  const handleClick = useCallback(() => {
    if (rootAcct) {
      history.push(`/@${rootAcct}/${rootId}`);
    }
  }, [history, rootAcct, rootId]);

  const disabled = !rootAcct;

  return (
    <button
      type='button'
      className='chain-collapse-indicator'
      onClick={handleClick}
      disabled={disabled}
      aria-disabled={disabled}
    >
      <span className='chain-collapse-indicator__dots' aria-hidden='true'>
        <span />
        <span />
        <span />
      </span>
      <span className='chain-collapse-indicator__label'>
        <FormattedMessage
          id='thread.show_more_replies'
          defaultMessage='더 많은 답글 보기'
        />
      </span>
    </button>
  );
};
