import type { InjectionWidgetModule } from '@open-mercato/shared/modules/widgets/injection'
import PortalMinWidget from './widget.client'

const widget: InjectionWidgetModule = {
  metadata: {
    id: 'prm.injection.portal-min',
    title: 'MIN — Most Important Number — Licenses',
    description: 'Enterprise licenses attributed to your agency this year.',
    features: ['prm.min.read_own_agency'],
    priority: 20,
    enabled: true,
  },
  Widget: PortalMinWidget,
}

export default widget
