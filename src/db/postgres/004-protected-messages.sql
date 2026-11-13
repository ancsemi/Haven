-- Keep protected rows even when a delete reaches them through a cascade.
CREATE FUNCTION keep_protected_message() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.is_archived = 1 THEN
    RAISE EXCEPTION 'protected message' USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END;
$$;

CREATE TRIGGER messages_keep_protected BEFORE DELETE ON messages
FOR EACH ROW EXECUTE FUNCTION keep_protected_message();
