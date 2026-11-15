import { useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router';
import { homePathFor, useAuth } from '../auth/AuthContext.jsx';
import { AuthLayout } from '../components/AuthLayout.jsx';
import { Button, ErrorAlert, SuccessAlert, inputClass } from '../components/ui.jsx';

export function LoginPage() {
  const { user, loading, login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  // Arriving from the activation page: confirm it worked and prefill the email.
  const activated = location.state?.activated === true;
  const [email, setEmail] = useState(activated ? (location.state?.email ?? '') : '');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  if (!loading && user) return <Navigate to={homePathFor(user)} replace />;

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      const loggedIn = await login(email, password);
      // Only return to the requested page if it belongs to this role's area.
      const from = location.state?.from;
      const home = homePathFor(loggedIn);
      navigate(from && from.startsWith(home) ? from : home, { replace: true });
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthLayout title="Sign in" subtitle="Use your WorkAgent account.">
      <form onSubmit={handleSubmit} className="space-y-4">
        {activated && !error && <SuccessAlert>Your account is active. Sign in with your new password.</SuccessAlert>}
        <ErrorAlert error={error} />

        <label className="block">
          <span className="text-[13px] font-medium text-slate-700">Email</span>
          <input type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} className={`${inputClass} mt-1.5 !py-2`} />
        </label>

        <label className="block">
          <span className="text-[13px] font-medium text-slate-700">Password</span>
          <input type="password" required autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} className={`${inputClass} mt-1.5 !py-2`} />
        </label>

        <Button type="submit" disabled={submitting} loading={submitting} className="!h-9 w-full">
          {submitting ? 'Signing in…' : 'Sign in'}
        </Button>
        <p className="text-center text-xs text-slate-500">Accounts are created by invitation. Ask your administrator if you need access.</p>
      </form>
    </AuthLayout>
  );
}
