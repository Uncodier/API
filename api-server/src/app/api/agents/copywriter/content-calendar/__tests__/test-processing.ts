// Sample target content that we want to test
export const sampleTargetContent = [
  {
    content: [
      {
        text: "# The Future of Education: Integrating Innovative Technology Solutions\n\n## Introduction\nIn the rapidly evolving landscape of education, technology plays a pivotal role in enhancing learning experiences. As educators and institutions strive to integrate innovative technology solutions, the potential for transforming education is immense. This blog post explores the key areas where technology is making a significant impact and how it is shaping the future of education.\n\n## The Rise of Educational Technology\nEducational technology, or EdTech, encompasses a wide range of tools and platforms designed to improve teaching and learning. From interactive whiteboards to virtual reality (VR) simulations, these technologies are revolutionizing the way educators deliver content and engage with students. The adoption of EdTech has been accelerated by the need for remote learning solutions during the COVID-19 pandemic, highlighting its importance in ensuring continuity of education.\n\n## Online Learning: Expanding Access and Flexibility\nOnline learning platforms have democratized education, making it accessible to a broader audience. These platforms offer flexibility, allowing students to learn at their own pace and from any location. With a plethora of courses available online, learners can acquire new skills and knowledge that were previously out of reach. The integration of artificial intelligence (AI) and machine learning (ML) in online learning platforms further personalizes the learning experience, catering to individual needs and preferences.\n\n## School Administration: Streamlining Operations\nInnovative technology solutions are not limited to the classroom; they also play a crucial role in school administration. From student information systems (SIS) to learning management systems (LMS), these tools streamline administrative tasks, improve communication, and enhance data management. By automating routine processes, educators can focus more on teaching and less on administrative duties, ultimately benefiting the entire educational ecosystem.\n\n## Innovation in Education: Fostering Creativity and Critical Thinking\nTechnology fosters creativity and critical thinking by providing students with new ways to explore and express their ideas. Tools such as coding platforms, 3D printing, and digital storytelling enable students to engage in hands-on, project-based learning. These experiences not only enhance their technical skills but also encourage problem-solving and collaboration, preparing them for the challenges of the future workforce.\n\n## Conclusion\nThe integration of innovative technology solutions in education is transforming the way we teach and learn. As educators and institutions continue to embrace these advancements, the potential for creating more engaging, inclusive, and effective learning environments is boundless. By staying at the forefront of technological innovation, we can ensure that education evolves to meet the needs of the 21st-century learner.\n\n## Call to Action\nStay updated with the latest trends in educational technology by subscribing to our blog. Join us in exploring the future of education and how technology is shaping the learning experiences of tomorrow.\n",
        type: "blog_post",
        title: "The Future of Education: Integrating Innovative Technology Solutions",
        description: "Explore how innovative technology solutions are transforming education, enhancing learning experiences, and shaping the future of teaching and learning.",
        estimated_reading_time: 10
      }
    ]
  }
];

// Function to extract content from command results - new version
export function extractContentFromResults(results: any[]): any[] {
  let contentResults: any[] = [];
  
  if (results && Array.isArray(results)) {
    // Find content with different possible paths
    const contentResult = results.find((r: any) => 
      r.type === 'content' || 
      (r.content && Array.isArray(r.content.content)) || 
      (Array.isArray(r.content))
    );
    
    if (contentResult) {
      if (contentResult.content && Array.isArray(contentResult.content.content)) {
        contentResults = contentResult.content.content;
      } else if (Array.isArray(contentResult.content)) {
        contentResults = contentResult.content;
      } else if (contentResult.type === 'content' && Array.isArray(contentResult)) {
        contentResults = contentResult;
      }
    } else {
      // Direct array of content object structure
      const directContentArray = results.find((r: any) => 
        r.content && Array.isArray(r.content)
      );
      
      if (directContentArray) {
        contentResults = directContentArray.content;
      }
    }
  }
  
  return contentResults;
}

// Mock function to save content items to database
export function saveContentItemsToDatabase(
  contentItems: any[],
  siteId: string
): any[] {
  return contentItems.map((item, index) => ({
    id: `test-item-${index}`,
    title: item.title || '',
    description: item.description || '',
    content: item.text || item.content || '',
    type: item.type || 'blog_post',
    status: 'draft',
    site_id: siteId,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  }));
}

// Function to run a test with the sample content
export function runContentExtractionTest() {
  // Simulate command execution with our target content
  const executedCommand = {
    id: 'test-command-id',
    status: 'completed',
    results: sampleTargetContent,
    task: 'create content calendar',
    user_id: 'test-user'
  };
  
  // Extract content results
  const contentResults = extractContentFromResults(executedCommand.results);
  console.log(`📊 Extracted ${contentResults.length} content items`);
  
  // Check content structure
  if (contentResults.length > 0) {
    const firstContent = contentResults[0];
    console.log('Content title:', firstContent.title);
    console.log('Content type:', firstContent.type);
    console.log('Content description:', firstContent.description);
    console.log('Content text preview:', firstContent.text.substring(0, 50) + '...');
  }
  
  // Simulate saving content to database
  const siteId = '00000000-0000-0000-0000-000000000000';
  const savedContentItems = saveContentItemsToDatabase(contentResults, siteId);
  
  return {
    command_id: executedCommand.id,
    siteId,
    content: savedContentItems,
    content_count: contentResults.length,
    saved_to_database: savedContentItems.length > 0,
    test_results: {
      content_structure: {
        test_name: 'Content structure verification',
        passed: contentResults.length > 0,
        message: contentResults.length > 0 
          ? 'Successfully extracted content from target structure' 
          : 'Failed to extract content from target structure'
      },
      content_fields: {
        test_name: 'Content fields verification',
        passed: contentResults.length > 0 && !!contentResults[0].title && !!contentResults[0].text,
        message: contentResults.length > 0 && !!contentResults[0].title && !!contentResults[0].text
          ? 'Content has all required fields'
          : 'Content is missing required fields'
      },
      database_processing: {
        test_name: 'Database processing simulation',
        passed: savedContentItems.length > 0,
        message: savedContentItems.length > 0
          ? 'Successfully processed content for database storage'
          : 'Failed to process content for database storage'
      }
    }
  };
} 