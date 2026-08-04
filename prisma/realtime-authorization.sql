-- Supabase-managed schema step. Run after the Prisma migration using a role
-- permitted to manage RLS policies on realtime.messages.
-- Cognito/Remnant user IDs are emitted as the custom Realtime JWT `sub`.

DROP POLICY IF EXISTS "remnant_authenticated_receive_messaging" ON realtime.messages;
CREATE POLICY "remnant_authenticated_receive_messaging"
ON realtime.messages
FOR SELECT
TO authenticated
USING (
  realtime.topic() = 'user:' || auth.uid()::text
  OR (
    realtime.topic() LIKE 'conversation:%'
    AND public.remnant_is_conversation_participant(
      substring(realtime.topic() FROM 14)
    )
  )
);

DROP POLICY IF EXISTS "remnant_participants_publish_ephemeral" ON realtime.messages;
CREATE POLICY "remnant_participants_publish_ephemeral"
ON realtime.messages
FOR INSERT
TO authenticated
WITH CHECK (
  realtime.topic() LIKE 'conversation:%'
  AND public.remnant_is_conversation_participant(
    substring(realtime.topic() FROM 14)
  )
);
