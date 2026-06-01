import { AuthenticatedUser } from './authenticated-user';

export const ADMIN_ROLE = 'admin';

export function hasRole(user: AuthenticatedUser | undefined, role: string) {
  return Boolean(
    user?.roles.some(
      userRole => userRole.toLowerCase() === role.toLowerCase(),
    ),
  );
}

export function isAdmin(user: AuthenticatedUser | undefined) {
  return hasRole(user, ADMIN_ROLE);
}
