import type { FC } from 'react';

import { FormattedMessage, useIntl } from 'react-intl';

import { useAccount } from '@/mastodon/hooks/useAccount';

import { NumberFields, NumberFieldsItem } from '../number_fields';
import { ShortNumber } from '../short_number';

import classes from './styles.module.scss';

// 폐쇄형 인스턴스 정책상 가입 일자(Joined)는 노출하지 않음.
// FormattedDateWrapper / openModal / ACCOUNT_JOIN_DATE 모달 의존도 함께 제거.
export const AccountNumberFields: FC<{ accountId: string }> = ({
  accountId,
}) => {
  const intl = useIntl();
  const account = useAccount(accountId);

  if (!account) {
    return null;
  }

  return (
    <NumberFields className={classes.numberFields}>
      <NumberFieldsItem
        label={
          <FormattedMessage id='account.followers' defaultMessage='Followers' />
        }
        hint={intl.formatNumber(account.followers_count)}
        link={`/@${account.acct}/followers`}
      >
        <ShortNumber value={account.followers_count} />
      </NumberFieldsItem>

      <NumberFieldsItem
        label={
          <FormattedMessage id='account.following' defaultMessage='Following' />
        }
        hint={intl.formatNumber(account.following_count)}
        link={`/@${account.acct}/following`}
      >
        <ShortNumber value={account.following_count} />
      </NumberFieldsItem>

      <NumberFieldsItem
        label={<FormattedMessage id='account.posts' defaultMessage='Posts' />}
        hint={intl.formatNumber(account.statuses_count)}
      >
        <ShortNumber value={account.statuses_count} />
      </NumberFieldsItem>
    </NumberFields>
  );
};
