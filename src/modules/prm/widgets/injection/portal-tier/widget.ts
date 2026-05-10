import type { InjectionWidgetModule } from '@open-mercato/shared/modules/widgets/injection'
import PortalTierWidget from './widget.client'

const widget: InjectionWidgetModule = {
  metadata: {
    id: 'prm.injection.portal-tier',
    title: 'Tier progress',
    description: 'Current tier and progress toward the next.',
    features: ['prm.dashboard.view', 'prm.tier_requirement.read'],
    priority: 15,
    enabled: true,
  },
  Widget: PortalTierWidget,
}

export default widget
