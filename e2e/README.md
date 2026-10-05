# End-to-end smoke test

`make e2e` builds the app and starts a throwaway stack (backend, a LiveKit container, a proxy in front
of them), then drives two or three real Chromium windows through it: signing in, chat and live updates,
a two-person voice call, the soundboard, settings, and signing out. It touches none of your own data or
services.

It needs Go, Node, Docker (with `livekit/livekit-server`) and Chromium; set `CHROMIUM` if it isn't on your
`PATH`. It uses ports 7890-7892, 18080 and 18090. `SHOTS=/some/dir make e2e` also saves screenshots.

`make a11y` runs the same stack through an accessibility audit instead: the axe engine over every main screen
(chat, a call, the dialogs and pop-ups, a phone-sized window, the sign-in screen), then checks of what a tool
can't judge: that Tab reaches a skip link, that dialogs take, hold and return focus, that menus work from the
keyboard, that new messages are announced but a channel's history isn't, and that reduced motion is honoured.
`./run.sh a11y --report` lists every element at fault.

`make test` runs neither: that's the quick check, without a browser or Docker.
