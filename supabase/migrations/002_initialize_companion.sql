update public.companions
set
  display_name = 'Companion',
  updated_at = now()
where id = 'f903741d-5382-45b2-bf7a-ac63c54a978b';

insert into public.relationship_state (
  owner_id,
  companion_id
)
select
  owner_id,
  id
from public.companions
where id = 'f903741d-5382-45b2-bf7a-ac63c54a978b'
and not exists (
  select 1
  from public.relationship_state
  where companion_id = 'f903741d-5382-45b2-bf7a-ac63c54a978b'
);