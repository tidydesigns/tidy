import { adminAc, ownerAc, memberAc } from "better-auth/plugins/organization/access";
export const organizationRoles = {
  owner: ownerAc,
  admin: adminAc,
  editor: memberAc,
  viewer: memberAc,
  member: memberAc,
};
