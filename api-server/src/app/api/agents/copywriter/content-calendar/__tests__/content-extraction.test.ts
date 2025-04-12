import { describe, it, expect } from '@jest/globals';

// Sample perfect target content matching what we need to test
const perfectTargetContent = [
  {
    contents: [
      {
        text: "# The Future of Education: Integrating Innovative Technology Solutions\n\n## Introduction\nIn the rapidly evolving landscape of education...",
        type: "blog_post",
        title: "The Future of Education: Integrating Innovative Technology Solutions",
        description: "Explore how innovative technology solutions are transforming education, enhancing learning experiences, and shaping the future of teaching and learning.",
        estimated_reading_time: 10
      }
    ]
  }
];

// Simulated command result with the perfect content format
const simulatedCommand = {
  id: 'test-command-id',
  status: 'completed',
  results: perfectTargetContent,
  task: 'create content calendar',
  user_id: 'test-user'
};

// Original extraction function from route.ts (before enhancement)
function originalExtractContentFromResults(executedCommand: any): any[] {
  let contentResults: any[] = [];
  
  if (executedCommand.results && Array.isArray(executedCommand.results)) {
    const contentsResult = executedCommand.results.find((r: any) => 
      r.type === 'contents' || (r.content && Array.isArray(r.content.contents))
    );
    
    if (contentsResult) {
      contentResults = contentsResult.content?.contents || contentsResult.contents || [];
    }
  }
  
  return contentResults;
}

// Enhanced extraction function from route.ts
function enhancedExtractContentFromResults(executedCommand: any): any[] {
  let contentResults: any[] = [];
  
  if (executedCommand.results && Array.isArray(executedCommand.results)) {
    // Try to find content using different possible paths
    const contentsResult = executedCommand.results.find((r: any) => 
      r.type === 'contents' || 
      (r.content && Array.isArray(r.content.contents)) || 
      (Array.isArray(r.contents))
    );
    
    if (contentsResult) {
      // Handle different content structures
      if (contentsResult.content && Array.isArray(contentsResult.content.contents)) {
        contentResults = contentsResult.content.contents;
      } else if (Array.isArray(contentsResult.contents)) {
        contentResults = contentsResult.contents;
      } else if (contentsResult.type === 'contents' && Array.isArray(contentsResult)) {
        contentResults = contentsResult;
      }
    } else {
      // Direct array of content object structure
      const directContentArray = executedCommand.results.find((r: any) => 
        r.contents && Array.isArray(r.contents)
      );
      
      if (directContentArray) {
        contentResults = directContentArray.contents;
      }
    }
  }
  
  return contentResults;
}

describe('Content Extraction Logic', () => {
  describe('Original extraction function', () => {
    it('should extract content items from command results', () => {
      const contentResults = originalExtractContentFromResults(simulatedCommand);
      
      // Verify that we can find content items
      expect(contentResults).toBeDefined();
      expect(Array.isArray(contentResults)).toBe(true);
    });
    
    it('should handle the perfect target content structure', () => {
      const contentResults = originalExtractContentFromResults(simulatedCommand);
      
      // Check if it correctly extracts content with the perfect format
      expect(contentResults.length).toBe(0); // We expect it to fail with the perfect structure
    });
  });
  
  describe('Enhanced extraction function', () => {
    it('should extract content items from command results', () => {
      const contentResults = enhancedExtractContentFromResults(simulatedCommand);
      
      // Verify that we can find content items
      expect(contentResults).toBeDefined();
      expect(Array.isArray(contentResults)).toBe(true);
    });
    
    it('should correctly handle the perfect target content structure', () => {
      const contentResults = enhancedExtractContentFromResults(simulatedCommand);
      
      // Check if it correctly extracts content with the perfect format
      expect(contentResults.length).toBe(1);
      
      // Verify content structure
      if (contentResults.length > 0) {
        const content = contentResults[0];
        expect(content.title).toBe("The Future of Education: Integrating Innovative Technology Solutions");
        expect(content.type).toBe("blog_post");
        expect(content.description).toBe("Explore how innovative technology solutions are transforming education, enhancing learning experiences, and shaping the future of teaching and learning.");
        expect(content.estimated_reading_time).toBe(10);
        expect(content.text).toContain("# The Future of Education");
      }
    });
    
    it('should handle various content result structures', () => {
      // Test with content in different formats
      
      // Format 1: Direct array with contents property
      const format1 = {
        results: [
          {
            contents: [{ title: "Test Title 1", text: "Test Content 1" }]
          }
        ]
      };
      
      // Format 2: Content with nested contents array
      const format2 = {
        results: [
          {
            content: {
              contents: [{ title: "Test Title 2", text: "Test Content 2" }]
            }
          }
        ]
      };
      
      // Format 3: Type-based content identification
      const format3 = {
        results: [
          {
            type: "contents",
            contents: [{ title: "Test Title 3", text: "Test Content 3" }]
          }
        ]
      };
      
      // Test all formats
      expect(enhancedExtractContentFromResults(format1).length).toBe(1);
      expect(enhancedExtractContentFromResults(format2).length).toBe(1);
      expect(enhancedExtractContentFromResults(format3).length).toBe(1);
    });
  });
}); 