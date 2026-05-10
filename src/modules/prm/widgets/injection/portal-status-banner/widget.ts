import type { InjectionWidgetModule } from '@open-mercato/shared/modules/widgets/injection'
import PortalStatusBannerWidget from './widget.client'

const widget: InjectionWidgetModule = {
  metadata: {
    id: 'prm.injection.portal-status-banner',
    title: 'Partner status banner',
    description: 'Warns partners whose agreement has been flagged historical.',
    features: ['prm.dashboard.view'],
    priority: 0,
    enabled: true,
  },
  Widget: PortalStatusBannerWidget,
}

export default widget
