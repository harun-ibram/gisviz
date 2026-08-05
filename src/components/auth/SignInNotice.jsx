import { useAuth } from '../../hooks/useAuth.js'

/**
 * The one line both upload surfaces show while signed out, next to their
 * disabled submit button — the same shape as queueFullMessage: a server-side
 * policy that disables submit, explained inline rather than by hiding the form.
 */
export default function SignInNotice({ action = 'upload' }) {
    const { requireLogin } = useAuth()

    return (
        <p className="text-muted gv-auth-notice">
            Sign in to {action}.
            <button type="button" className="btn btn-ghost" onClick={requireLogin}>
                Sign in
            </button>
        </p>
    )
}
