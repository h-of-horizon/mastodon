import { PureComponent } from 'react';

import { Helmet } from '@unhead/react/helmet';
import { Route } from 'react-router-dom';

import { Provider as ReduxProvider } from 'react-redux';

import { expandConversations } from 'mastodon/actions/conversations';
import { hydrateStore } from 'mastodon/actions/store';
import { connectDirectStream, connectUserStream } from 'mastodon/actions/streaming';
import ErrorBoundary from 'mastodon/components/error_boundary';
import { Router } from 'mastodon/components/router';
import UI from 'mastodon/features/ui';
import { IdentityContext, createIdentityContext } from 'mastodon/identity_context';
import { initialState, title as siteTitle } from 'mastodon/initial_state';
import { IntlProvider } from 'mastodon/locales';
import { store } from 'mastodon/store';
import { isProduction } from 'mastodon/utils/environment';
import { BodyScrollLock } from 'mastodon/features/ui/components/body_scroll_lock';

import { ScrollContext } from './scroll_container/scroll_context';

const title = isProduction() ? siteTitle : `${siteTitle} (Dev)`;

const hydrateAction = hydrateStore(initialState);

store.dispatch(hydrateAction);

export default class Mastodon extends PureComponent {
  identity = createIdentityContext(initialState);

  componentDidMount() {
    if (this.identity.signedIn) {
      this.disconnect = store.dispatch(connectUserStream());

      // 폐쇄형 인스턴스 정책: 좌측 nav 의 DM 메뉴 badge 를 위해
      // 앱 마운트 시 conversations 초기 fetch + direct 스트림 전역 연결.
      // 사용자가 /conversations 페이지에 안 들어가도 새 DM 도착 시 실시간 카운트 갱신.
      store.dispatch(expandConversations());
      this.disconnectDirect = store.dispatch(connectDirectStream());
    }
  }

  componentWillUnmount () {
    if (this.disconnect) {
      this.disconnect();
      this.disconnect = null;
    }

    if (this.disconnectDirect) {
      this.disconnectDirect();
      this.disconnectDirect = null;
    }
  }

  render () {
    return (
      <IdentityContext.Provider value={this.identity}>
        <IntlProvider>
          <ReduxProvider store={store}>
            <ErrorBoundary>
              <Router>
                <ScrollContext>
                  <Route path='/' component={UI} />
                </ScrollContext>
                <BodyScrollLock />
              </Router>

              <Helmet defaultTitle={title} titleTemplate={`%s - ${title}`} />
            </ErrorBoundary>
          </ReduxProvider>
        </IntlProvider>
      </IdentityContext.Provider>
    );
  }

}
