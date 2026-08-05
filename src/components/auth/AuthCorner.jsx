import { useEffect, useRef, useState } from 'react'
import { useAuth } from '../../hooks/useAuth.js'
import LoginDialog from './LoginDialog.jsx'
import { IconLogOut, IconUser } from '../icons.jsx'

/**
 * The login-status widget, pinned bottom-left on every route. Rendered as a
 * sibling of .gv-shell rather than inside it: the shell is overflow:hidden and
 * would clip a fixed child.
 */
export default function AuthCorner() {
    const { user, isAuthed, logout, requireLogin, dialogOpen, closeDialog } = useAuth()

    const [popoverOpen, setPopoverOpen] = useState(false)
    const buttonRef = useRef(null)
    const cornerRef = useRef(null)

    // Derived rather than synced through an effect: signing out anywhere else
    // (an expired token, say) must not leave an empty popover on screen.
    const showPopover = isAuthed && popoverOpen

    useEffect(() => {
        if (!showPopover) {
            return undefined
        }

        const onKeyDown = (event) => {
            if (event.key === 'Escape') {
                setPopoverOpen(false)
                buttonRef.current?.focus()
            }
        }

        const onPointerDown = (event) => {
            if (!cornerRef.current?.contains(event.target)) {
                setPopoverOpen(false)
            }
        }

        document.addEventListener('keydown', onKeyDown)
        document.addEventListener('pointerdown', onPointerDown)

        return () => {
            document.removeEventListener('keydown', onKeyDown)
            document.removeEventListener('pointerdown', onPointerDown)
        }
    }, [showPopover])

    const handleClick = () => {
        if (isAuthed) {
            setPopoverOpen((current) => !current)
        } else {
            requireLogin()
        }
    }

    const handleDialogClose = () => {
        closeDialog()
        buttonRef.current?.focus()
    }

    return (
        <>
            <div className="gv-auth-corner" ref={cornerRef}>
                {showPopover ? (
                    <div className="gv-auth-pop" role="group" aria-label="Account">
                        <span className="gv-auth-pop-email">{user.email}</span>
                        <button
                            type="button"
                            className="btn btn-secondary btn-block"
                            onClick={() => {
                                logout()
                                setPopoverOpen(false)
                                buttonRef.current?.focus()
                            }}
                        >
                            <IconLogOut />
                            Sign out
                        </button>
                    </div>
                ) : null}

                <button
                    ref={buttonRef}
                    type="button"
                    className={`gv-tool gv-auth-fab${isAuthed ? ' gv-auth-fab--in' : ''}`}
                    onClick={handleClick}
                    aria-expanded={isAuthed ? showPopover : undefined}
                    aria-label={isAuthed ? `Signed in as ${user.email}` : 'Sign in'}
                    title={isAuthed ? user.email : 'Sign in'}
                >
                    <IconUser />
                    {isAuthed ? <span className="gv-pulse-dot gv-auth-dot" /> : null}
                </button>
            </div>

            {dialogOpen ? <LoginDialog onClose={handleDialogClose} /> : null}
        </>
    )
}
