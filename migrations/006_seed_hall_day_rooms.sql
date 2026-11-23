INSERT INTO rooms(type, name, hall_id, day_id)
SELECT 'hall_day', h.name || ' → ' || d.label, h.id, d.id
FROM halls h CROSS JOIN festival_days d
WHERE h.deleted_at IS NULL
ON CONFLICT DO NOTHING;
