import { randomUUID } from "node:crypto";
import { hashPassword } from "better-auth/crypto";

// Shared browser fixtures skip email delivery; verification itself is exercised
// in test:auth and test:auth:browser. Only disposable loopback databases qualify.
export async function verifiedTestAccount(client, { name, email, password }) {
  if (!["localhost", "127.0.0.1"].includes(client.connectionParameters.host))
    throw new Error("Verified test accounts require a disposable loopback database.");
  const user = (
    await client.query(
      `insert into "user" ("id","name","email","emailVerified") values ($1,$2,$3,true)
    on conflict ("email") do update set "name"=$2,"emailVerified"=true returning "id"`,
      [randomUUID(), name, email],
    )
  ).rows[0];
  const credential = (
    await client.query(
      'select "id" from "account" where "userId"=$1 and "providerId"=\'credential\'',
      [user.id],
    )
  ).rows[0];
  const hash = await hashPassword(password);
  if (credential)
    await client.query('update "account" set "password"=$1,"updatedAt"=now() where "id"=$2', [
      hash,
      credential.id,
    ]);
  else
    await client.query(
      `insert into "account" ("id","accountId","providerId","userId","password","updatedAt") values ($1,$2,'credential',$2,$3,now())`,
      [randomUUID(), user.id, hash],
    );
  return user.id;
}
