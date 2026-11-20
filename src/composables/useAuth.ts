import { onMounted, onUnmounted, ref } from 'vue';
import { ApiError, request } from '../model';

type AuthState = {
  mode: 'wechat' | 'mock' | 'demo' | 'roster';
  status: 'anonymous' | 'registration' | 'player' | 'demo';
  expiresIn?: number;
  needsGender?: boolean;
  prefill?: { school: string; name: string; studentNo: string; phone: string };
};

export type Gender = 'male' | 'female';

export type RegistrationForm = {
  school: string;
  name: string;
  studentNo: string;
  grade: string;
  college: string;
  className: string;
  phone: string;
  email: string;
  gender: Gender | '';
};

export function useAuth() {
  const auth = ref<AuthState>();
  const authBusy = ref(false);
  const authIssue = ref('');
  let expiryTimer = 0;
  let revision = 0;

  function apply(next: AuthState) {
    window.clearTimeout(expiryTimer);
    auth.value = next;
    authIssue.value = '';
    if (next.expiresIn !== undefined) {
      expiryTimer = window.setTimeout(() => {
        apply({ mode: next.mode, status: 'anonymous' });
        void syncAuth();
      }, next.expiresIn * 1000);
    }
  }

  async function syncAuth() {
    if (authBusy.value) return;
    const version = ++revision;
    try {
      const next = await request<AuthState>('/api/auth/session');
      if (version === revision) apply(next);
    } catch (error) {
      if (version === revision && !auth.value) authIssue.value = (error as Error).message;
    }
  }

  async function submit(path: string, body: object) {
    if (authBusy.value) return;
    authBusy.value = true;
    authIssue.value = '';
    ++revision;
    try {
      apply(await request<AuthState>(path, body));
    } catch (error) {
      if (error instanceof ApiError && error.code === 'AUTH' && auth.value) {
        apply({ mode: auth.value.mode, status: 'anonymous' });
      }
      authIssue.value = (error as Error).message;
    } finally {
      authBusy.value = false;
    }
  }

  function recheck() {
    if (!document.hidden) void syncAuth();
  }

  onMounted(() => {
    void syncAuth();
    window.addEventListener('focus', recheck);
    window.addEventListener('pageshow', recheck);
    document.addEventListener('visibilitychange', recheck);
  });
  onUnmounted(() => {
    ++revision;
    window.clearTimeout(expiryTimer);
    window.removeEventListener('focus', recheck);
    window.removeEventListener('pageshow', recheck);
    document.removeEventListener('visibilitychange', recheck);
  });

  return {
    auth, authBusy, authIssue, syncAuth,
    rosterLogin: (data: { studentNo: string; name: string; phoneLast4: string }) => submit('/api/auth/roster', data),
    register: (data: RegistrationForm) => submit('/api/auth/register', data),
    completeGender: (gender: RegistrationForm['gender']) => submit('/api/auth/gender', { gender }),
    logout: () => submit('/api/auth/logout', {}),
  };
}
