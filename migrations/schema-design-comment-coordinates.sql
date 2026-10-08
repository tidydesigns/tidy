-- Apply to databases that already used the original schema-design-comments.sql.
-- Allows comments anywhere on the canvas, including negative world coordinates.
alter table "designCommentThread"
  drop constraint "designCommentThread_x_check",
  drop constraint "designCommentThread_y_check",
  add constraint "designCommentThread_x_check" check ("x" between -100000 and 100000),
  add constraint "designCommentThread_y_check" check ("y" between -100000 and 100000);
