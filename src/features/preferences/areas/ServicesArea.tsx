import { SectionTitle } from '@/app/ui'
import { ServiceStatus } from '@/app/ServiceStatus'
import { ModelsPanel } from '../ModelsPanel'

export function ServicesArea() {
  return (
    <div className="max-w-xl space-y-8">
      <section className="space-y-2">
        <SectionTitle
          title="Servicios"
          description="Estado de los procesos locales que acompañan a la aplicación."
        />
        <ServiceStatus />
      </section>
      <section className="space-y-2">
        <h3 className="text-h3 font-semibold">Modelos</h3>
        <ModelsPanel />
      </section>
    </div>
  )
}
