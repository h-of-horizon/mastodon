import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { defineMessage, FormattedMessage, useIntl } from 'react-intl';

import type { Map as ImmutableMap } from 'immutable';

import CancelFillIcon from '@/material-icons/400-24px/cancel-fill.svg?react';
import { fetchRelationships } from 'mastodon/actions/accounts';
import { revealAccount } from 'mastodon/actions/accounts_typed';
import { fetchStatus } from 'mastodon/actions/statuses';
import { LearnMoreLink } from 'mastodon/components/learn_more_link';
import StatusContainer from 'mastodon/containers/status_container';
import { domain } from 'mastodon/initial_state';
import type { Account } from 'mastodon/models/account';
import type { Status } from 'mastodon/models/status';
import { makeGetStatusWithExtraInfo } from 'mastodon/selectors';
import { getAccountHidden } from 'mastodon/selectors/accounts';
import type { RootState } from 'mastodon/store';
import { useAppDispatch, useAppSelector } from 'mastodon/store';

import { Button } from './button';
import { ChainCollapseIndicator } from './chain_collapse_indicator';
import { IconButton } from './icon_button';
import type { StatusHeaderRenderFn } from './status/header';
import { StatusHeader } from './status/header';

const MAX_QUOTE_POSTS_NESTING_LEVEL = 1;

const NestedQuoteLink: React.FC<{ status: Status }> = ({ status }) => {
  const accountObjectOrId = status.get('account') as string | Account;
  const accountId =
    typeof accountObjectOrId === 'string'
      ? accountObjectOrId
      : accountObjectOrId.id;

  const account = useAppSelector((state) =>
    accountId ? state.accounts.get(accountId) : undefined,
  );

  const quoteAuthorName = account?.acct;

  if (!quoteAuthorName) {
    return null;
  }

  return (
    <div className='status__quote-author-button'>
      <FormattedMessage
        id='status.quote_post_author'
        defaultMessage='Quoted a post by @{name}'
        values={{ name: quoteAuthorName }}
      />
    </div>
  );
};

type GetStatusSelector = (
  state: RootState,
  props: { id?: string | null; contextType?: string },
) => {
  status: Status | null;
  loadingState: 'not-found' | 'loading' | 'filtered' | 'complete';
};

type QuoteMap = ImmutableMap<'state' | 'quoted_status', string | null>;

const LimitedAccountHint: React.FC<{ accountId: string }> = ({ accountId }) => {
  const dispatch = useAppDispatch();
  const reveal = useCallback(() => {
    dispatch(revealAccount({ id: accountId }));
  }, [dispatch, accountId]);

  return (
    <>
      <FormattedMessage
        id='status.quote_error.limited_account_hint.title'
        defaultMessage='This account has been hidden by the moderators of {domain}.'
        values={{ domain }}
      />
      <button onClick={reveal} className='link-button' type='button'>
        <FormattedMessage
          id='status.quote_error.limited_account_hint.action'
          defaultMessage='Show anyway'
        />
      </button>
    </>
  );
};

const FilteredQuote: React.FC<{
  reveal: VoidFunction;
  quotedAccountId: string;
  quoteState: string;
}> = ({ reveal, quotedAccountId, quoteState }) => {
  const account = useAppSelector((state) =>
    quotedAccountId ? state.accounts.get(quotedAccountId) : undefined,
  );

  const quoteAuthorName = account?.acct;
  const domain = quoteAuthorName?.split('@')[1];

  let message;

  switch (quoteState) {
    case 'blocked_account':
      message = (
        <FormattedMessage
          id='status.quote_error.blocked_account_hint.title'
          defaultMessage="This post is hidden because you've blocked @{name}."
          values={{ name: quoteAuthorName }}
        />
      );
      break;
    case 'blocked_domain':
      message = (
        <FormattedMessage
          id='status.quote_error.blocked_domain_hint.title'
          defaultMessage="This post is hidden because you've blocked {domain}."
          values={{ domain }}
        />
      );
      break;
    case 'muted_account':
      message = (
        <FormattedMessage
          id='status.quote_error.muted_account_hint.title'
          defaultMessage="This post is hidden because you've muted @{name}."
          values={{ name: quoteAuthorName }}
        />
      );
  }

  return (
    <>
      {message}
      <button onClick={reveal} className='link-button' type='button'>
        <FormattedMessage
          id='status.quote_error.limited_account_hint.action'
          defaultMessage='Show anyway'
        />
      </button>
    </>
  );
};

interface QuotedStatusProps {
  quote: QuoteMap;
  contextType?: string;
  parentQuotePostId?: string | null;
  variant?: 'full' | 'link';
  nestingLevel?: number;
  onQuoteCancel?: () => void; // Used for composer.
}

const quoteCancelMessage = defineMessage({
  id: 'status.quote.cancel',
  defaultMessage: 'Cancel quote',
});

export const QuotedStatus: React.FC<QuotedStatusProps> = ({
  quote,
  contextType,
  parentQuotePostId,
  nestingLevel = 1,
  variant = 'full',
  onQuoteCancel,
}) => {
  const dispatch = useAppDispatch();
  const quoteState = useAppSelector((state) =>
    parentQuotePostId
      ? state.statuses.getIn([parentQuotePostId, 'quote', 'state'])
      : quote.get('state'),
  );

  const quotedStatusId = quote.get('quoted_status');
  const getStatusSelector = useMemo(
    () => makeGetStatusWithExtraInfo() as GetStatusSelector,
    [],
  );
  const { status, loadingState } = useAppSelector((state) =>
    getStatusSelector(state, { id: quotedStatusId, contextType }),
  );

  const accountId: string | null = status?.get('account')
    ? (status.get('account') as Account).id
    : null;
  const hiddenAccount = useAppSelector(
    (state) => accountId && getAccountHidden(state, accountId),
  );

  const shouldFetchQuote =
    !status?.get('isLoading') &&
    quoteState !== 'deleted' &&
    loadingState === 'not-found';
  const isLoaded = loadingState === 'complete';

  const isFetchingQuoteRef = useRef(false);
  const [revealed, setRevealed] = useState(false);

  const reveal = useCallback(() => {
    setRevealed(true);
  }, [setRevealed]);

  useEffect(() => {
    if (isLoaded) {
      isFetchingQuoteRef.current = false;
    }
  }, [isLoaded]);

  useEffect(() => {
    if (shouldFetchQuote && quotedStatusId && !isFetchingQuoteRef.current) {
      dispatch(
        fetchStatus(quotedStatusId, {
          parentQuotePostId,
          alsoFetchContext: false,
        }),
      );
      isFetchingQuoteRef.current = true;
    }
  }, [shouldFetchQuote, quotedStatusId, parentQuotePostId, dispatch]);

  useEffect(() => {
    if (accountId && hiddenAccount) dispatch(fetchRelationships([accountId]));
  }, [accountId, hiddenAccount, dispatch]);

  const intl = useIntl();
  const headerRenderFn: StatusHeaderRenderFn = useCallback(
    (props) => (
      <StatusHeader {...props}>
        {onQuoteCancel && (
          <IconButton
            onClick={onQuoteCancel}
            className='status__quote-cancel'
            title={intl.formatMessage(quoteCancelMessage)}
            icon='cancel-fill'
            iconComponent={CancelFillIcon}
          />
        )}
      </StatusHeader>
    ),
    [intl, onQuoteCancel],
  );

  const isFilteredAndHidden = loadingState === 'filtered';

  let quoteError: React.ReactNode = null;

  if (isFilteredAndHidden) {
    quoteError = (
      <FormattedMessage
        id='status.quote_error.filtered'
        defaultMessage='Hidden due to one of your filters'
      />
    );
  } else if (quoteState === 'pending') {
    quoteError = (
      <>
        <FormattedMessage
          id='status.quote_error.pending_approval'
          defaultMessage='Post pending'
        />

        <LearnMoreLink>
          <p>
            <FormattedMessage
              id='status.quote_error.pending_approval_popout.body'
              defaultMessage="On Mastodon, you can control whether someone can quote you. This post is pending while we're getting the original author's approval."
            />
          </p>
        </LearnMoreLink>
      </>
    );
  } else if (quoteState === 'revoked') {
    quoteError = (
      <FormattedMessage
        id='status.quote_error.revoked'
        defaultMessage='Post removed by author'
      />
    );
  } else if (
    (quoteState === 'blocked_account' ||
      quoteState === 'blocked_domain' ||
      quoteState === 'muted_account') &&
    !revealed &&
    accountId
  ) {
    quoteError = (
      <FilteredQuote
        quoteState={quoteState}
        reveal={reveal}
        quotedAccountId={accountId}
      />
    );
  } else if (
    !status ||
    !quotedStatusId ||
    quoteState === 'deleted' ||
    quoteState === 'rejected' ||
    quoteState === 'unauthorized'
  ) {
    quoteError = (
      <FormattedMessage
        id='status.quote_error.not_available'
        defaultMessage='Post unavailable'
      />
    );
  } else if (hiddenAccount && accountId) {
    quoteError = <LimitedAccountHint accountId={accountId} />;
  }

  if (quoteError) {
    const hasRemoveButton = contextType === 'composer' && !!onQuoteCancel;

    return (
      <div className='status__quote status__quote--error'>
        {quoteError}
        {hasRemoveButton && (
          <Button compact plain onClick={onQuoteCancel}>
            <FormattedMessage
              id='status.remove_quote'
              defaultMessage='Remove'
            />
          </Button>
        )}
      </div>
    );
  }

  if (variant === 'link' && status) {
    return <NestedQuoteLink status={status} />;
  }

  const childQuote = status?.get('quote') as QuoteMap | undefined;
  const canRenderChildQuote =
    childQuote && nestingLevel <= MAX_QUOTE_POSTS_NESTING_LEVEL;

  return (
    <div className='status__quote'>
      <StatusContainer
        isQuotedPost
        id={quotedStatusId}
        contextType={contextType}
        avatarSize={32}
        headerRenderFn={headerRenderFn}
      >
        {canRenderChildQuote && (
          <QuotedStatus
            quote={childQuote}
            parentQuotePostId={quotedStatusId}
            contextType={contextType}
            variant={
              nestingLevel === MAX_QUOTE_POSTS_NESTING_LEVEL ? 'link' : 'full'
            }
            nestingLevel={nestingLevel + 1}
          />
        )}
      </StatusContainer>
    </div>
  );
};

export interface StatusQuoteManagerProps {
  id: string;
  contextType?: string;
  [key: string]: unknown;
}

/**
 * This wrapper component takes a status ID and, if the associated status
 * is a quote post, it renders the quote into `StatusContainer` as a child.
 * It passes all other props through to `StatusContainer`.
 */

export const StatusQuoteManager = (props: StatusQuoteManagerProps) => {
  const status = useAppSelector((state) => {
    const status = state.statuses.get(props.id);
    const reblogId = status?.get('reblog') as string | undefined;
    return reblogId ? state.statuses.get(reblogId) : status;
  });

  // Twitter X 식 "더 많은 답글 보기" indicator 표시 조건:
  //   • home timeline 일 때만 (contextType === 'home')
  //   • status 가 답글 (in_reply_to_id 있음)
  //   • 직접 부모가 home timeline 에 없음 = chain 의 중간 답글이 생략됨
  //     (서버측 home_feed.rb 의 chain compress 결과 — root + leaf 만 inject)
  //
  // 표시 위치: leaf 카드 위 별도 cell (Twitter X 정합 — article 외부, 카드 사이).
  // 클릭 시 chain root (또는 가장 가까운 ancestor) 의 상세 페이지로 이동.
  //
  // 표시 조건 — 단순화된 룰 (스크롤 시 추가 fetch 로 chain 의 중간 답글이
  // timeline 에 들어와도 indicator 유지):
  //   • 직전 timeline item 이 자기의 직속 부모 (in_reply_to_id) 가 아닐 때 표시
  //   • 즉 직속 답글이 아닌 모든 답글에 indicator + rootId = 직전 item
  //
  // 이전 룰 (`items.includes(inReplyToId)`) 의 문제:
  //   스크롤로 추가 fetch 가 chain 의 중간 답글을 timeline 에 가져오면 leaf 의
  //   in_reply_to_id 가 timeline 에 있게 되어 indicator 가 갑자기 사라짐.
  //   직전 item 비교만으로 chain compress 시각 안정 유지.
  const chainCollapseInfo = useAppSelector((state) => {
    if (props.contextType !== 'home') return null;
    const currentStatus = state.statuses.get(props.id);
    const inReplyToId = currentStatus?.get('in_reply_to_id') as string | null;
    if (!inReplyToId) return null;

    const items = state.timelines.getIn(['home', 'items']) ?? null;
    if (!items) return null;

    const itemsList = items as unknown as {
      indexOf: (id: string) => number;
      get: (i: number) => unknown;
    };

    const currentIdx = itemsList.indexOf(props.id);
    if (currentIdx <= 0) return null;

    const previousId = itemsList.get(currentIdx - 1);
    if (typeof previousId !== 'string') return null;

    // 직전 item 이 자기 직속 부모면 chain compress 아님 (단순 직속 답글)
    if (inReplyToId === previousId) return null;

    return { rootId: previousId };
  });

  const quote = status?.get('quote') as QuoteMap | undefined;

  // Indicator 는 leaf 카드 직전에 배치 (article 외부, 카드 사이 별도 cell — Twitter X 정합)
  const collapseIndicator = chainCollapseInfo ? (
    <ChainCollapseIndicator rootId={chainCollapseInfo.rootId} />
  ) : null;

  if (quote) {
    return (
      <>
        {collapseIndicator}
        <StatusContainer {...props}>
          <QuotedStatus
            quote={quote}
            parentQuotePostId={status?.get('id') as string}
            contextType={props.contextType}
          />
        </StatusContainer>
      </>
    );
  }

  return (
    <>
      {collapseIndicator}
      <StatusContainer {...props} />
    </>
  );
};
