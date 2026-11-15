import { Loader2 } from 'lucide-react';
import { Navigate, Outlet, useLocation } from 'react-router';
import { homePathFor, useAuth } from './AuthContext.jsx';

// Client-side guard for UX only; the API enforces authentication and roles itself.
export function ProtectedRoute({ roles }) {
  const { user, loading } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center gap-2 text-sm text-slate-500">
        <Loader2 size={16} className="animate-spin" aria-hidden="true" />
        Loading…
      </div>
    );
  }
  if (!user) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }
  if (roles && !roles.includes(user.role)) {
    return <Navigate to={homePathFor(user)} replace />;
  }
  return <Outlet />;
}
