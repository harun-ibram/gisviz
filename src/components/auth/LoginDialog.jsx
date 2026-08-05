import { useEffect, useState } from 'react'
import { useAuth } from '../../hooks/useAuth.js'
import { IconEye, IconEyeOff } from '../icons.jsx'

/**
 * The centred popup, following the confirm-dialog pattern already in
 * GisLayerLibrary: a plain conditional render, no portal and no <dialog>
 * element, with the modal semantics declared on the backdrop.
 *
 * The fields sit in a real <form> so Enter submits and password managers can
 * see the pair.
 */
export default function LoginDialog({ onClose }) {
    const { login } = useAuth()

    const [email, setEmail] = useState('')
    const [password, setPassword] = useState('')
    const [showPassword, setShowPassword] = useState(false)
    const [pending, setPending] = useState(false)
    const [error, setError] = useState('')

    useEffect(() => {
        const onKeyDown = (event) => {
            if (event.key === 'Escape') {
                onClose()
            }
        }

        document.addEventListener('keydown', onKeyDown)
        return () => document.removeEventListener('keydown', onKeyDown)
    }, [onClose])

    const handleSubmit = async (event) => {
        event.preventDefault()

        if (pending) {
            return
        }

        setError('')
        setPending(true)

        try {
            await login(email.trim(), password)
            onClose()
        } catch (loginError) {
            // The backend writes the user-grade copy — a generic "Invalid email
            // or password" for 401, a throttling message for 429 — so it is
            // rendered verbatim, as everywhere else in the app.
            setError(loginError?.message || 'Could not sign in.')
            setPending(false)
        }
    }

    return (
        <div
            className="dialog-backdrop"
            role="dialog"
            aria-modal="true"
            aria-label="Sign in"
            onClick={(event) => {
                if (event.target === event.currentTarget) {
                    onClose()
                }
            }}
        >
            <div className="dialog">
                <div className="dialog-title">Sign in</div>

                <form className="gv-auth-form" onSubmit={handleSubmit}>
                    <div className="field">
                        <label className="gv-detail-label" htmlFor="auth-email">Email</label>
                        <input
                            id="auth-email"
                            className="input"
                            type="email"
                            autoComplete="username"
                            autoFocus
                            required
                            value={email}
                            onChange={(event) => setEmail(event.target.value)}
                        />
                    </div>

                    <div className="field">
                        <label className="gv-detail-label" htmlFor="auth-password">Password</label>
                        <div className="gv-auth-secret">
                            <input
                                id="auth-password"
                                className="input"
                                type={showPassword ? 'text' : 'password'}
                                autoComplete="current-password"
                                required
                                value={password}
                                onChange={(event) => setPassword(event.target.value)}
                            />
                            <button
                                type="button"
                                className="gv-tool"
                                onClick={() => setShowPassword((current) => !current)}
                                aria-label={showPassword ? 'Hide password' : 'Show password'}
                                aria-pressed={showPassword}
                                title={showPassword ? 'Hide password' : 'Show password'}
                            >
                                {showPassword ? <IconEyeOff /> : <IconEye />}
                            </button>
                        </div>
                    </div>

                    {error ? <p className="gv-library-error">{error}</p> : null}

                    <div className="dialog-actions">
                        <button type="button" className="btn btn-secondary" onClick={onClose}>
                            Cancel
                        </button>
                        <button type="submit" className="btn btn-primary" disabled={pending}>
                            {pending ? 'Signing in…' : 'Sign in'}
                        </button>
                    </div>
                </form>
            </div>
        </div>
    )
}
