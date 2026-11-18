-- Q-25 refinement (p0-publicaciones): a CANCELLED publication frees the ciclo. Legacy
-- blocked re-creation forever after a cancel (full UNIQUE (fk_agricultor, semana) over
-- any state → IntegrityError on re-create) — a defect we do not inherit (scope.md
-- principle 1). The farmer may re-draft the same ciclo; cancelado rows stop colliding.
DROP INDEX IF EXISTS "publicacion_semanal_agricultor_ciclo_unico";
CREATE UNIQUE INDEX "publicacion_semanal_agricultor_ciclo_unico" ON "publicacion_semanal"("fk_agricultor", "fecha_ciclo") WHERE "fk_agricultor" IS NOT NULL AND "estado" <> 'cancelado';
