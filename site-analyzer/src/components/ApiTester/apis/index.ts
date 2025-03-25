import apiRegistry from '../apiRegistry';
import GeneralApi from './GeneralApi';
import AiApi from './AiApi';
import SiteApi from './SiteApi';
import SegmentsApi from './SegmentsApi';
import TesterApi from './TesterApi';
import IcpApi from './IcpApi';
import ContentApi from './ContentApi';
import RequirementsApi from './RequirementsApi';
import BasicAnalyzeApi from './BasicAnalyzeApi';
import VisitorSessionApi from './VisitorSessionApi';

// Registrar todas las APIs
apiRegistry.register(GeneralApi);
apiRegistry.register(AiApi);
apiRegistry.register(SiteApi);
apiRegistry.register(SegmentsApi);
apiRegistry.register(TesterApi);
apiRegistry.register(IcpApi);
apiRegistry.register(ContentApi);
apiRegistry.register(RequirementsApi);
apiRegistry.register(BasicAnalyzeApi);
apiRegistry.register(VisitorSessionApi);

export default apiRegistry; 