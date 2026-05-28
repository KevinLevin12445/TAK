# TODO - Deploy a Vercel (TAK)

- [x] Revisar estructura del repo y configuración existente (vercel.json, frontend, backend).
- [x] Asegurar build de frontend para Vercel (outputDirectory correcto para `artifacts/ak-terminal`) (pendiente ajuste de outputDirectory en Vercel/settings).
- [x] Ajustar configuración de Vercel para servir el SPA y reenrutar correctamente (rewrite ya está en `vercel.json`, requiere output dir).
- [ ] Adaptar `artifacts/api-server` para ejecutarse en Vercel (serverless) o decidir alternativa.

- [ ] Verificar base URL del API desde el frontend (para que apunte a las rutas /api en Vercel).
- [ ] Probar build completo local (frontend + backend) simulando entorno Vercel.
- [ ] Dejar lista guía de despliegue en Vercel (build command, install command, output dir, env vars).

