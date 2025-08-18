import './GeneralApi';
import AiApi from './AiApi';
import SiteApi from './SiteApi';
import SegmentsApi from './SegmentsApi';
import TesterApi from './TesterApi';
import IcpApi from './IcpApi';
import ContentApi from './ContentApi';
import VisitorSegmentApi from './VisitorSegmentApi';
import SendEmailFromAgentApi from './SendEmailFromAgentApi';
import SendWhatsAppApi from './SendWhatsAppApi';
import CustomerSupportApi from './CustomerSupportApi';
import EmailAnalysisApi from './EmailAnalysisApi';
import VisitorIdentifyApi from './VisitorIdentifyApi';
import VisitorTrackApi from './VisitorTrackApi';
import VisitorSessionApi from './VisitorSessionApi';
import AgentsAppsApi from './AgentsAppsApi';
import CustomerSupportConversationMessagesApi from './CustomerSupportConversationMessagesApi';
import SalesApi from './SalesApi';
import InterventionApi from './InterventionApi';
import GrowthApi from './GrowthApi';
import CmoStakeholderCoordinationApi from './CmoStakeholderCoordinationApi';
import CustomerSupportConversationsApi from './CustomerSupportConversationsApi';
import RequirementsApi from './RequirementsApi';
import HtmlPersonalizationApi from './HtmlPersonalizationApi';
import BasicAnalyzeApi from './BasicAnalyzeApi';
import CopywriterApi from './CopywriterApi';
import ChatApi from './ChatApi';
import CreateTaskApi from './CreateTaskApi';
import GetTaskApi from './GetTaskApi';
import UpdateTaskApi from './UpdateTaskApi';
import ValidateEmailApi from './ValidateEmailApi';

// ApiRegistry class
class ApiRegistry {
  private apis: Map<string, any> = new Map();

  register(api: any) {
    this.apis.set(api.id, api);
  }

  get(id: string) {
    return this.apis.get(id);
  }

  getAll() {
    return Array.from(this.apis.values());
  }
}

const apiRegistry = new ApiRegistry();

// Register all APIs
apiRegistry.register(AiApi);
apiRegistry.register(SiteApi);
apiRegistry.register(SegmentsApi);
apiRegistry.register(TesterApi);
apiRegistry.register(IcpApi);
apiRegistry.register(ContentApi);
apiRegistry.register(VisitorSegmentApi);
apiRegistry.register(SendEmailFromAgentApi);
apiRegistry.register(SendWhatsAppApi);
apiRegistry.register(CustomerSupportApi);
apiRegistry.register(EmailAnalysisApi);
apiRegistry.register(VisitorIdentifyApi);
apiRegistry.register(VisitorTrackApi);
apiRegistry.register(VisitorSessionApi);
apiRegistry.register(AgentsAppsApi);
apiRegistry.register(CustomerSupportConversationMessagesApi);
apiRegistry.register(SalesApi);
apiRegistry.register(InterventionApi);
apiRegistry.register(GrowthApi);
apiRegistry.register(CmoStakeholderCoordinationApi);
apiRegistry.register(CustomerSupportConversationsApi);
apiRegistry.register(RequirementsApi);
apiRegistry.register(HtmlPersonalizationApi);
apiRegistry.register(BasicAnalyzeApi);
apiRegistry.register(CopywriterApi);
apiRegistry.register(ChatApi);
apiRegistry.register(CreateTaskApi);
apiRegistry.register(GetTaskApi);
apiRegistry.register(UpdateTaskApi);
apiRegistry.register(ValidateEmailApi);

export default apiRegistry;

// Exportar también APIs individuales para casos específicos
export {
  AiApi,
  SiteApi,
  SegmentsApi,
  TesterApi,
  IcpApi,
  ContentApi,
  VisitorSegmentApi,
  SendEmailFromAgentApi,
  SendWhatsAppApi,
  CustomerSupportApi,
  EmailAnalysisApi,
  VisitorIdentifyApi,
  VisitorTrackApi,
  VisitorSessionApi,
  AgentsAppsApi,
  CustomerSupportConversationMessagesApi,
  SalesApi,
  InterventionApi,
  GrowthApi,
  CmoStakeholderCoordinationApi,
  CustomerSupportConversationsApi,
  RequirementsApi,
  HtmlPersonalizationApi,
  BasicAnalyzeApi,
  CopywriterApi,
  ChatApi,
  CreateTaskApi,
  GetTaskApi,
  UpdateTaskApi,
  ValidateEmailApi
}; 