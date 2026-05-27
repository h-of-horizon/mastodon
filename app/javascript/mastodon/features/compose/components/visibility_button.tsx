import { useCallback, useMemo } from 'react';
import type { FC } from 'react';

import { defineMessages, useIntl } from 'react-intl';

import classNames from 'classnames';

import {
  changeComposeVisibility,
  setComposeQuotePolicy,
} from '@/mastodon/actions/compose_typed';
import { openModal } from '@/mastodon/actions/modal';
import type { ApiQuotePolicy } from '@/mastodon/api_types/quotes';
import type { StatusVisibility } from '@/mastodon/api_types/statuses';
import { Icon } from '@/mastodon/components/icon';
import { useAppSelector, useAppDispatch } from '@/mastodon/store';
import MailIcon from '@/material-icons/400-24px/mail.svg?react';
import LockIcon from '@/material-icons/400-24px/lock.svg?react';
import PublicIcon from '@/material-icons/400-24px/public.svg?react';
import QuietTimeIcon from '@/material-icons/400-24px/quiet_time.svg?react';

import type { VisibilityModalCallback } from '../../ui/components/visibility_modal';

import { messages as privacyMessages } from './privacy_dropdown';

const messages = defineMessages({
  anyone_quote: {
    id: 'privacy.quote.anyone',
    defaultMessage: '{visibility}, anyone can quote',
  },
  limited_quote: {
    id: 'privacy.quote.limited',
    defaultMessage: '{visibility}, quotes limited',
  },
  disabled_quote: {
    id: 'privacy.quote.disabled',
    defaultMessage: '{visibility}, quotes disabled',
  },
  // DM 답글 시 visibility 변경 잠금 안내
  dm_locked: {
    id: 'compose_form.privacy.dm_locked',
    defaultMessage: 'DM 답글은 DM으로만 전송됩니다',
  },
});

interface PrivacyDropdownProps {
  disabled?: boolean;
}

export const VisibilityButton: FC<PrivacyDropdownProps> = (props) => {
  return <PrivacyModalButton {...props} />;
};

const visibilityOptions = {
  public: {
    icon: 'globe',
    iconComponent: PublicIcon,
    value: 'public',
    text: privacyMessages.public_short,
  },
  unlisted: {
    icon: 'unlock',
    iconComponent: QuietTimeIcon,
    value: 'unlisted',
    text: privacyMessages.unlisted_short,
  },
  private: {
    icon: 'lock',
    iconComponent: LockIcon,
    value: 'private',
    text: privacyMessages.private_short,
  },
  direct: {
    icon: 'mail',
    iconComponent: MailIcon,
    value: 'direct',
    text: privacyMessages.direct_short,
  },
};

const PrivacyModalButton: FC<PrivacyDropdownProps> = ({ disabled = false }) => {
  const intl = useIntl();

  const quotePolicy = useAppSelector(
    (state) => state.compose.get('quote_policy') as ApiQuotePolicy,
  );
  const visibility = useAppSelector(
    (state) => state.compose.get('privacy') as StatusVisibility,
  );

  // DM 답글 lock — 답글 대상이 DM(direct visibility) 이면 사용자가 visibility 를
  // 변경할 수 없게 button disable + tooltip 안내.
  // 서버측 PostStatusService 가 :direct 로 강제하므로 데이터 안전성은 보장되지만,
  // 사용자에게 명확한 UX 시그널 제공.
  const lockedToDirect = useAppSelector((state) => {
    const replyToId = state.compose.get('in_reply_to') as string | null;
    if (!replyToId) return false;
    return state.statuses.getIn([replyToId, 'visibility']) === 'direct';
  });

  const { icon, iconComponent } = useMemo(() => {
    const option = visibilityOptions[visibility];
    return { icon: option.icon, iconComponent: option.iconComponent };
  }, [visibility]);
  const text = useMemo(() => {
    const visibilityText = intl.formatMessage(
      visibilityOptions[visibility].text,
    );
    if (visibility === 'private' || visibility === 'direct') {
      return visibilityText;
    }
    if (quotePolicy === 'nobody') {
      return intl.formatMessage(messages.disabled_quote, {
        visibility: visibilityText,
      });
    }
    if (quotePolicy !== 'public') {
      return intl.formatMessage(messages.limited_quote, {
        visibility: visibilityText,
      });
    }
    return intl.formatMessage(messages.anyone_quote, {
      visibility: visibilityText,
    });
  }, [quotePolicy, visibility, intl]);

  const dispatch = useAppDispatch();

  const handleChange: VisibilityModalCallback = useCallback(
    (newVisibility, newQuotePolicy) => {
      if (newVisibility !== visibility) {
        dispatch(changeComposeVisibility(newVisibility));
      }
      if (newQuotePolicy !== quotePolicy) {
        dispatch(setComposeQuotePolicy(newQuotePolicy));
      }
    },
    [dispatch, quotePolicy, visibility],
  );

  const handleOpen = useCallback(() => {
    dispatch(
      openModal({
        modalType: 'COMPOSE_PRIVACY',
        modalProps: { onChange: handleChange },
      }),
    );
  }, [dispatch, handleChange]);

  return (
    <button
      type='button'
      title={intl.formatMessage(lockedToDirect ? messages.dm_locked : privacyMessages.change_privacy)}
      onClick={handleOpen}
      disabled={disabled || lockedToDirect}
      className={classNames('dropdown-button')}
    >
      <Icon id={icon} icon={iconComponent} />
      <span className='dropdown-button__label'>{text}</span>
    </button>
  );
};
