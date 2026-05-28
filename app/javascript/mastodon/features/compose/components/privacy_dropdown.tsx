import { useCallback, useRef, useState } from 'react';

import { defineMessages, useIntl } from 'react-intl';

import classNames from 'classnames';

import type { OverlayProps } from 'react-overlays/Overlay';
import Overlay from 'react-overlays/Overlay';

import type { StatusVisibility } from '@/mastodon/api_types/statuses';
import MailIcon from '@/material-icons/400-24px/mail.svg?react';
import PublicIcon from '@/material-icons/400-24px/public.svg?react';
import { DropdownSelector } from 'mastodon/components/dropdown_selector';
import { Icon } from 'mastodon/components/icon';

export const messages = defineMessages({
  public_short: { id: 'privacy.public.short', defaultMessage: 'Public' },
  public_long: {
    id: 'privacy.public.long',
    defaultMessage: 'Anyone on and off Mastodon',
  },
  unlisted_short: {
    id: 'privacy.unlisted.short',
    defaultMessage: 'Quiet public',
  },
  unlisted_long: {
    id: 'privacy.unlisted.long',
    defaultMessage:
      'Hidden from Mastodon search results, trending, and public timelines',
  },
  private_short: { id: 'privacy.private.short', defaultMessage: 'Followers' },
  private_long: {
    id: 'privacy.private.long',
    defaultMessage: 'Only your followers',
  },
  direct_short: {
    id: 'privacy.direct.short',
    defaultMessage: 'Specific people',
  },
  direct_long: {
    id: 'privacy.direct.long',
    defaultMessage: 'Everyone mentioned in the post',
  },
  change_privacy: {
    id: 'privacy.change',
    defaultMessage: 'Change post privacy',
  },
  unlisted_extra: {
    id: 'privacy.unlisted.additional',
    defaultMessage:
      'This behaves exactly like public, except the post will not appear in live feeds or hashtags, explore, or Mastodon search, even if you are opted-in account-wide.',
  },
});

interface PrivacyDropdownProps {
  value: StatusVisibility;
  onChange: (value: StatusVisibility) => void;
  noDirect?: boolean;
  container?: OverlayProps['container'];
  disabled?: boolean;
}

const PrivacyDropdown: React.FC<PrivacyDropdownProps> = ({
  value,
  onChange,
  noDirect,
  container,
  disabled,
}) => {
  const intl = useIntl();
  const overlayTargetRef = useRef<HTMLDivElement | null>(null);
  const previousFocusTargetRef = useRef<HTMLElement | null>(null);
  const [isOpen, setIsOpen] = useState(false);

  const handleClose = useCallback(() => {
    if (isOpen && previousFocusTargetRef.current) {
      previousFocusTargetRef.current.focus({ preventScroll: true });
    }
    setIsOpen(false);
  }, [isOpen]);

  const handleToggle = useCallback(() => {
    if (isOpen) {
      handleClose();
    }
    setIsOpen((prev) => !prev);
  }, [handleClose, isOpen]);

  const registerPreviousFocusTarget = useCallback(() => {
    if (!isOpen) {
      previousFocusTargetRef.current = document.activeElement as HTMLElement;
    }
  }, [isOpen]);

  const handleButtonKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if ([' ', 'Enter'].includes(e.key)) {
        registerPreviousFocusTarget();
      }
    },
    [registerPreviousFocusTarget],
  );

  // 폐쇄형 인스턴스 정책: '조용한 공개' (unlisted) 와 '팔로워' (private) 옵션 제거.
  // public 과 direct (DM) 만 노출.
  const options = [
    {
      icon: 'globe',
      iconComponent: PublicIcon,
      value: 'public',
      text: intl.formatMessage(messages.public_short),
      meta: intl.formatMessage(messages.public_long),
    },
  ];

  if (!noDirect) {
    options.push({
      icon: 'mail',
      iconComponent: MailIcon,
      value: 'direct',
      text: intl.formatMessage(messages.direct_short),
      meta: intl.formatMessage(messages.direct_long),
    });
  }

  const selectedOption =
    options.find((item) => item.value === value) ?? options.at(0);

  return (
    <div ref={overlayTargetRef}>
      <button
        type='button'
        title={intl.formatMessage(messages.change_privacy)}
        aria-expanded={isOpen}
        onClick={handleToggle}
        onMouseDown={registerPreviousFocusTarget}
        onKeyDown={handleButtonKeyDown}
        disabled={disabled}
        className={classNames('dropdown-button', { active: isOpen })}
      >
        {selectedOption && (
          <>
            <Icon
              id={selectedOption.icon}
              icon={selectedOption.iconComponent}
            />
            <span className='dropdown-button__label'>
              {selectedOption.text}
            </span>
          </>
        )}
      </button>

      <Overlay
        show={isOpen}
        offset={[5, 5]}
        placement='bottom'
        flip
        target={overlayTargetRef}
        container={container}
        popperConfig={{ strategy: 'fixed' }}
      >
        {({ props, placement }) => (
          <div {...props}>
            <div
              className={`dropdown-animation privacy-dropdown__dropdown ${placement}`}
            >
              <DropdownSelector
                items={options}
                value={value}
                onClose={handleClose}
                // @ts-expect-error DropdownSelector doesn't yet return the correct type for onChange
                onChange={onChange}
              />
            </div>
          </div>
        )}
      </Overlay>
    </div>
  );
};

// eslint-disable-next-line import/no-default-export
export default PrivacyDropdown;
