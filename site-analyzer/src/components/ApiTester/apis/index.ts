import apiRegistry from '../apiRegistry';
import GeneralApi from './GeneralApi';
import AiApi from './AiApi';
import SiteApi from './SiteApi';
import SegmentsApi from './SegmentsApi';

// Registrar todas las APIs
apiRegistry.register(GeneralApi);
apiRegistry.register(AiApi);
apiRegistry.register(SiteApi);
apiRegistry.register(SegmentsApi);

export default apiRegistry; 