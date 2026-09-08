import { boot } from '@twentyfour/shell'
import { AdminApp } from './AdminApp'

// The admin plane. Naming it here registers the admin handlers in development
// and leaves the merchant ones out, so a screen that reached for /api would
// fail rather than quietly work against the wrong gateway.
//
// VITE_ADMIN_API points the console at a real admin gateway and stands the mock
// down entirely. It is all or nothing on purpose: a mock sign-in and a real
// data call disagree about who is signed in, and the result is a console that
// looks authenticated and is refused by everything it asks for.
void boot(<AdminApp />, {
  plane: 'admin',
  mock: !import.meta.env['VITE_ADMIN_API'],
})
