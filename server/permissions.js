/**
 * Role + granular permission model.
 *
 * The database keeps the original role keys (owner/manager/staff) so historic
 * users, audit rows and bills stay valid. The UI and API expose them under the
 * business names the hotel uses:
 *   owner   -> Admin          (full control, settings + user management)
 *   manager -> Manager        (day-to-day operations)
 *   staff   -> Billing Staff  (billing only unless the Admin grants more)
 *
 * Permissions are stored per user as a JSON array in users.permissions. A user
 * with no stored value falls back to the role defaults below, so every existing
 * account keeps exactly the access it had before this module existed.
 */

export const ROLE_LABELS = {
  owner: 'Admin',
  manager: 'Manager',
  staff: 'Billing Staff',
};

export const PERMISSION_DEFS = [
  { key: 'stock_add', label: 'Add stock (purchases)', hint: 'Record new stock received' },
  { key: 'stock_edit', label: 'Edit / adjust stock', hint: 'Corrections, wastage and returns' },
  { key: 'reports_view', label: 'View reports & analytics', hint: 'Sales, stock and closing reports' },
  { key: 'products_manage', label: 'Manage products & prices', hint: 'Create and edit products, categories, prices' },
  { key: 'settings_access', label: 'Access settings & user management', hint: 'Admin only — create logins and set permissions' },
];

export const PERMISSION_KEYS = PERMISSION_DEFS.map((p) => p.key);

export const ROLE_DEFAULTS = {
  owner: [...PERMISSION_KEYS],
  manager: ['stock_add', 'stock_edit', 'reports_view', 'products_manage'],
  staff: [],
};

/** Owner is always Admin; settings_access can never be granted to anyone else. */
export function roleLabel(role) {
  return ROLE_LABELS[role] || role;
}

export function normalizePermissions(role, raw) {
  const base = new Set(ROLE_DEFAULTS[role] || []);
  let parsed = raw;
  if (typeof raw === 'string') {
    try {
      parsed = raw ? JSON.parse(raw) : null;
    } catch {
      parsed = null;
    }
  }
  if (Array.isArray(parsed)) {
    for (const key of parsed) {
      if (PERMISSION_KEYS.includes(key)) base.add(key);
    }
  }
  if (role === 'owner') return [...PERMISSION_KEYS];
  base.delete('settings_access');
  return PERMISSION_KEYS.filter((k) => base.has(k));
}

/** Resolve the effective permission list for a user row or public user object. */
export function permissionsFor(user) {
  if (!user) return [];
  return normalizePermissions(user.role, user.permissions);
}

export function hasPermission(user, key) {
  return permissionsFor(user).includes(key);
}

/** Validate an Admin-supplied permission array before saving. */
export function sanitizePermissions(role, requested) {
  if (!Array.isArray(requested)) return null;
  const wanted = requested.filter((k) => PERMISSION_KEYS.includes(k));
  return normalizePermissions(role, wanted);
}
