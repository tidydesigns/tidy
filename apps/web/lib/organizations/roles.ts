/** One workspace role per membership. `member` is the legacy spelling of Editor. */
export type OrganizationRole = "viewer" | "editor" | "admin" | "owner";
export type StoredOrganizationRole = OrganizationRole | "member";
export type Permission = "view" | "comment" | "edit" | "manage" | "own";
const grants: Record<Permission, readonly StoredOrganizationRole[]> = {
  view: ["viewer", "editor", "member", "admin", "owner"],
  comment: ["viewer", "editor", "member", "admin", "owner"],
  edit: ["editor", "member", "admin", "owner"],
  manage: ["admin", "owner"],
  own: ["owner"],
};
export function can(role: string | null | undefined, permission: Permission) {
  return grants[permission].includes(role as StoredOrganizationRole);
}
export function roleLabel(role: string | null | undefined) {
  const normalized = role === "member" ? "editor" : role;
  return normalized && can(normalized, "view")
    ? normalized[0].toUpperCase() + normalized.slice(1)
    : "Unknown role";
}
export function canAssignRole(actor: string, role: string) {
  return (
    can(actor, "manage") &&
    (["viewer", "editor", "member"].includes(role) || (role === "admin" && can(actor, "own")))
  );
}
export function canManageMember(actor: string, target: string) {
  return (
    can(actor, "own") || (actor === "admin" && ["viewer", "editor", "member"].includes(target))
  );
}
export const inviteRoleOptions = [
  { value: "viewer", label: "Viewer — can view and comment" },
  { value: "editor", label: "Editor — can edit designs" },
  { value: "admin", label: "Admin — can manage the workspace" },
];
// Static SQL literals derived from the same policy, never from request input.
export const EDIT_ROLES_SQL = `(${grants.edit.map((role) => `'${role}'`).join(", ")})`;

export const VIEW_ROLES_SQL = `(${grants.view.map((role) => `'${role}'`).join(", ")})`;
export const MANAGE_ROLES_SQL = `(${grants.manage.map((role) => `'${role}'`).join(", ")})`;
