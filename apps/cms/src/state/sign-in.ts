/** Signing in: the email step, the code step, and GitHub. */
import { authClient, authErrorMessage } from '~/lib/auth-client';
import { initialOrgs } from './orgs';
import type { SliceCreator } from './store';

interface SignInState {
  step: 'email' | 'code';
  email: string;
  code: string;
  pending: 'send' | 'verify' | 'github' | null;
  error: string | null;
  /** A confirmation on the code step, such as a new code being sent. */
  notice: string | null;
}

export interface SignInSlice {
  signIn: SignInState;
  editEmail: (email: string) => void;
  /** Keeps digits only, at most six. */
  editCode: (code: string) => void;
  /** Emails a code and moves to the code step. */
  startSignIn: () => Promise<void>;
  /** Emails a new code from the code step. */
  resendCode: () => Promise<void>;
  /** Signs in with the code, then goes to `next`. */
  submitCode: (next: string) => Promise<void>;
  /** Back to the email step, keeping the address typed so far. */
  changeEmail: () => void;
  /** Hands the browser to GitHub, which returns to `next`. */
  signInWithGitHub: (next: string) => Promise<void>;
}

const initialSignIn: SignInState = { step: 'email', email: '', code: '', pending: null, error: null, notice: null };

export const createSignInSlice: SliceCreator<SignInSlice> = (set, get, { router }) => {
  const started = (pending: SignInState['pending']) => set((s) => ({ signIn: { ...s.signIn, pending, error: null, notice: null } }));
  const failed = (error: string) => set((s) => ({ signIn: { ...s.signIn, pending: null, error } }));

  async function sendCode() {
    const { step, email } = get().signIn;
    started('send');
    const { error } = await authClient.emailOtp.sendVerificationOtp({ email: email.trim(), type: 'sign-in' });
    if (error) return failed(authErrorMessage(error, 'We could not send a code. Check the address and try again.'));
    set((s) => ({ signIn: { ...s.signIn, step: 'code', code: '', pending: null, notice: step === 'code' ? 'We sent a new code.' : null } }));
  }

  return {
    signIn: initialSignIn,
    editEmail: (email) => set((s) => ({ signIn: { ...s.signIn, email } })),
    editCode: (code) => set((s) => ({ signIn: { ...s.signIn, code: code.replace(/\D/g, '').slice(0, 6) } })),
    startSignIn: sendCode,
    resendCode: sendCode,
    changeEmail: () => set((s) => ({ signIn: { ...s.signIn, step: 'email', error: null, notice: null } })),

    async submitCode(next) {
      const { email, code } = get().signIn;
      started('verify');
      const { error } = await authClient.signIn.emailOtp({ email: email.trim(), otp: code.trim() });
      if (error) return failed(authErrorMessage(error, 'That code did not work. Check it, or ask for a new one.'));
      await router.invalidate();
      await router.navigate({ href: next, replace: true });
      // A new person is signed in: nothing from the last visit to sign-in or the org picker carries over.
      set({ signIn: initialSignIn, orgs: initialOrgs });
    },

    async signInWithGitHub(next) {
      set((s) => ({ signIn: { ...s.signIn, pending: 'github', error: null } }));
      const { error } = await authClient.signIn.social({ provider: 'github', callbackURL: next, errorCallbackURL: '/sign-in' });
      if (error) failed(authErrorMessage(error, 'GitHub sign-in is not available right now.'));
    },
  };
};
