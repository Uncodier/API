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
import HtmlPersonalizationApi from './HtmlPersonalizationApi';
import VisitorTrackApi from './VisitorTrackApi';
import VisitorIdentifyApi from './VisitorIdentifyApi';
import VisitorSegmentApi from './VisitorSegmentApi';
import AgentsIntegrationsApi from './AgentsIntegrationsApi';
import CustomerSupportApi from './CustomerSupportApi';
import CustomerSupportConversationsApi from './CustomerSupportConversationsApi';
import CustomerSupportConversationMessagesApi from './CustomerSupportConversationMessagesApi';
import CopywriterApi from './CopywriterApi';
import ChatApi from './ChatApi';
import GrowthApi from './GrowthApi';
import InterventionApi from './InterventionApi';
import SalesApi from './SalesApi';
import CmoStakeholderCoordinationApi from './CmoStakeholderCoordinationApi';
import EmailAnalysisApi from './EmailAnalysisApi';
import ContactHumanApi from './ContactHumanApi';
import SendEmailFromAgentApi from './SendEmailFromAgentApi';

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
apiRegistry.register(HtmlPersonalizationApi);
apiRegistry.register(VisitorTrackApi);
apiRegistry.register(VisitorIdentifyApi);
apiRegistry.register(VisitorSegmentApi);
apiRegistry.register(AgentsIntegrationsApi);
apiRegistry.register(CustomerSupportApi);
apiRegistry.register(CustomerSupportConversationsApi);
apiRegistry.register(CustomerSupportConversationMessagesApi);
apiRegistry.register(CopywriterApi);
apiRegistry.register(ChatApi);
apiRegistry.register(GrowthApi);
apiRegistry.register(InterventionApi);
apiRegistry.register(SalesApi);
apiRegistry.register(CmoStakeholderCoordinationApi);
apiRegistry.register(EmailAnalysisApi);
apiRegistry.register(ContactHumanApi);
apiRegistry.register(SendEmailFromAgentApi);

// Exportar el registry como default
export default apiRegistry;

// Exportar también APIs individuales para casos específicos
export {
  GeneralApi,
  AiApi,
  SiteApi,
  SegmentsApi,
  TesterApi,
  IcpApi,
  ContentApi,
  RequirementsApi,
  BasicAnalyzeApi,
  VisitorSessionApi,
  HtmlPersonalizationApi,
  VisitorTrackApi,
  VisitorIdentifyApi,
  VisitorSegmentApi,
  AgentsIntegrationsApi,
  CustomerSupportApi,
  CustomerSupportConversationsApi,
  CustomerSupportConversationMessagesApi,
  CopywriterApi,
  ChatApi,
  GrowthApi,
  InterventionApi,
  SalesApi,
  CmoStakeholderCoordinationApi,
  EmailAnalysisApi,
  ContactHumanApi,
  SendEmailFromAgentApi
}; 