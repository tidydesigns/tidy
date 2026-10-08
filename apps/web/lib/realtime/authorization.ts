import { VIEW_ROLES_SQL } from "../organizations/roles";

// Both admission and reauthorization use live verified identity, membership and session state.
export const roomConnectionQuery = `select m."role" from "designFile" f join "member" m on m."organizationId" = f."organizationId" and m."userId" = $2
        join "session" s on s."userId" = m."userId" and s."id" = $3 and s."expiresAt" > now()
        join "user" u on u."id" = s."userId" and u."emailVerified" = true
        where m."role" in ${VIEW_ROLES_SQL} and f."id" = $1 and f."organizationId" = $4 and f."archivedAt" is null`;

export const roomSessionsQuery = `select s."id", m."role" from "session" s join "member" m on m."userId" = s."userId"
          join "user" u on u."id" = s."userId" and u."emailVerified" = true
          join "designFile" f on f."organizationId" = m."organizationId" where m."role" in ${VIEW_ROLES_SQL} and f."id" = $1 and f."archivedAt" is null
          and s."id" = any($2::text[]) and s."expiresAt" > now()`;
