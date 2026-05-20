import { useMemo } from 'react';
import type { ComponentPropsWithoutRef, FC } from 'react';

import { Skeleton } from '../skeleton';

import type { DisplayNameProps } from './index';
import { DisplayNameWithoutDomain } from './no-domain';

export function useAccountHandle(
  account: DisplayNameProps['account'],
  _localDomain: DisplayNameProps['localDomain'],
) {
  return useMemo(() => {
    if (!account) {
      return null;
    }
    // acct가 이미 '@'로 시작하는 비정상 데이터(예: '@notice')가 들어와도
    // 결과가 '@@notice'가 되지 않도록 방어적으로 leading '@'를 제거.
    // 또한 local 사용자에게는 @localDomain 을 붙이지 않아 '@notice' 처럼
    // 깔끔하게 노출. (Remote 사용자는 acct 자체가 'user@remote.tld' 형태라
    // 결과는 자연스럽게 '@user@remote.tld'.)
    const acct = account.get('acct').replace(/^@+/, '');
    return `@${acct}`;
  }, [account]);
}

export const DisplayNameDefault: FC<
  Omit<DisplayNameProps, 'variant'> & ComponentPropsWithoutRef<'span'>
> = ({ account, localDomain, className, ...props }) => {
  const username = useAccountHandle(account, localDomain);

  return (
    <DisplayNameWithoutDomain
      account={account}
      className={className}
      {...props}
    >
      {' '}
      <span className='display-name__account'>
        {username ?? <Skeleton width='7ch' />}
      </span>
    </DisplayNameWithoutDomain>
  );
};
