import type { InjectionWidgetModule } from '@open-mercato/shared/modules/widgets/injection'
import PortalMinWidget from './widget.client'

const widget: InjectionWidgetModule = {
  metadata: {
    id: 'prm.injection.portal-min',
    title: 'MIN Attribution',
    description: "Yearly Minimum Income Network attribution from this Agency's licensed deals.",
    features: ['prm.min.read_own_agency'],
    priority: 20,
    enabled: true,
  },
  Widget: PortalMinWidget,
}

export default widget
