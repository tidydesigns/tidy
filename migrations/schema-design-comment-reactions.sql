-- Apply after schema-design-comments.sql, through an approved database change.
create table "designCommentReaction" (
  "messageId" text not null references "designCommentMessage" ("id") on delete cascade,
  "userId" text not null references "user" ("id") on delete cascade,
  "emoji" text not null check ("emoji" in ('👍', '❤️', '😂', '😮', '🎉', '👀')),
  "createdAt" timestamptz not null default now(),
  primary key ("messageId", "userId", "emoji")
);

create index "designCommentReaction_messageId_idx" on "designCommentReaction" ("messageId");
