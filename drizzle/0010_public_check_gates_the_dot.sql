-- The reachability monitor became required: a published app nobody outside
-- can reach should not report green.
--
-- Needed as a migration because planReconcile only ever rewrites an existing
-- monitor's `config`, never its `required` flag — it treats that flag as a
-- user edit worth preserving. True for devices, which have an editor for it;
-- for apps there is no such editor, so the flag can only ever have come from
-- desiredMonitors, and leaving it alone would pin every already-provisioned
-- app to the old advisory behaviour forever.
UPDATE monitors SET required = 1
  WHERE target_type = 'app' AND type = 'reachability';
