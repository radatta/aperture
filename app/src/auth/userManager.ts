import { UserManager } from 'oidc-client-ts';
import { COGNITO_AUTHORITY, COGNITO_CLIENT_ID } from '../shared/env';
import { getUserStore } from './userStore';

// We construct the UserManager ourselves rather than let react-oidc-context build one from props,
// because we need the *unwrapped* one. The context wraps every navigator method (signinSilent included)
// to flip isLoading and to swallow rejections into `return null` — so a renew driven through the context
// can't tell "offline" from "the authority rejected the grant", which is the one distinction the renew
// handling turns on. Calling this manager directly gives us the real rejection.
let manager: UserManager | undefined;

export const getUserManager = (): UserManager =>
  (manager ??= new UserManager({
    authority: COGNITO_AUTHORITY,
    client_id: COGNITO_CLIENT_ID,
    redirect_uri: window.location.origin,
    post_logout_redirect_uri: window.location.origin,
    response_type: 'code',
    scope: 'openid email',
    automaticSilentRenew: true,
    userStore: getUserStore(),
    monitorSession: false, // already the default; pinned because Cognito publishes no check_session_iframe
  }));
