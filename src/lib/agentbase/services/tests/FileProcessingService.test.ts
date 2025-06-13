/**
 * Tests para verificar el procesamiento de archivos en FileProcessingService
 */
import { FileProcessingService } from '../FileProcessingService';
import { DatabaseAdapter } from '../../adapters/DatabaseAdapter';

// Mock para DatabaseAdapter
jest.mock('../../adapters/DatabaseAdapter', () => ({
  DatabaseAdapter: {
    getAgentFileContent: jest.fn().mockImplementation(async (filePath: string) => {
      
      // Handle by exact file path or filename
      if (filePath.includes('test.csv') || filePath === 'test.csv') {
        return 'id,name,value\n1,Test Item,100\n2,Another Item,200';
      } else if (filePath.includes('doc.md') || filePath === 'doc.md') {
        return `# Test Documentation

## Overview
This is a test Markdown file.

### Features
- Feature 1
- Feature 2

\`\`\`javascript
console.log('test');
\`\`\``;
      } else if (filePath.includes('guide.markdown') || filePath === 'guide.markdown') {
        return `# User Guide

Welcome to our application!

## Getting Started
Follow these steps to get started.`;
      } else if (filePath.includes('readme.md') || filePath === 'readme.md') {
        return `# README

This is a test readme file.

## Installation
npm install

## Usage
npm start`;
      } else if (filePath.includes('config.json') || filePath === 'config.json' || filePath.includes('settings.json') || filePath === 'settings.json') {
        return `{
  "name": "test-app",
  "version": "1.0.0",
  "settings": {
    "debug": true,
    "port": 3000
  }
}`;
      } else if (filePath.includes('notes.txt') || filePath === 'notes.txt' || filePath.includes('data.txt') || filePath === 'data.txt') {
        return `Estas son las notas importantes del proyecto.

Configuración:
- Usar puerto 3000
- Habilitar debug en desarrollo
- Revisar logs diariamente

Contactos:
- Admin: admin@example.com
- Support: support@example.com`;
      } else if (filePath.includes('docker-compose.yml') || filePath === 'docker-compose.yml' || filePath.includes('config.yml') || filePath === 'config.yml') {
        return `version: '3.8'
services:
  app:
    image: node:16
    ports:
      - "3000:3000"
    environment:
      - NODE_ENV=production
    volumes:
      - ./src:/app/src
  db:
    image: postgres:13
    environment:
      - POSTGRES_DB=testdb
      - POSTGRES_USER=user
      - POSTGRES_PASSWORD=password`;
      }
      
      // Handle by file ID - need to be smart about which content to return
      else if (filePath === 'file1') {
        // Default to CSV for backwards compatibility, unless context suggests otherwise
        return 'id,name,value\n1,Test Item,100\n2,Another Item,200';
      } else if (filePath === 'file2') {
        // Could be markdown or JSON depending on test context
        return `{
  "name": "test-app",
  "version": "1.0.0",
  "settings": {
    "debug": true,
    "port": 3000
  }
}`;
      } else if (filePath === 'file3') {
        return `Estas son las notas importantes del proyecto.

Configuración:
- Usar puerto 3000
- Habilitar debug en desarrollo
- Revisar logs diariamente

Contactos:
- Admin: admin@example.com
- Support: support@example.com`;
      } else if (filePath === 'file4') {
        return `version: '3.8'
services:
  app:
    image: node:16
    ports:
      - "3000:3000"
    environment:
      - NODE_ENV=production
    volumes:
      - ./src:/app/src
  db:
    image: postgres:13
    environment:
      - POSTGRES_DB=testdb
      - POSTGRES_USER=user
      - POSTGRES_PASSWORD=password`;
      }
      
      return null;
    })
  }
}));

// Mock global fetch
global.fetch = jest.fn();

describe('FileProcessingService', () => {
  let fileProcessingService: FileProcessingService;

  beforeEach(() => {
    jest.clearAllMocks();
    fileProcessingService = FileProcessingService.getInstance();
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  it('should process CSV files correctly', async () => {
    const mockFiles = [
      {
        id: 'file1',
        name: 'test.csv',
        file_path: 'test.csv',
        file_type: 'csv'
      }
    ];

    const background = 'Initial background';
    const result = await fileProcessingService.appendAgentFilesToBackground(background, mockFiles);

    expect(result).toContain('## Reference Files');
    expect(result).toContain('### test.csv');
    expect(result).toContain('```csv');
    expect(result).toContain('id,name,value');
    expect(result).toContain('1,Test Item,100');
  });

  it('should process Markdown files correctly', async () => {
    const mockFiles = [
      {
        id: 'file1',
        name: 'doc.md',
        file_path: 'doc.md',
        file_type: 'md'
      }
    ];

    const background = 'Initial background';
    const result = await fileProcessingService.appendAgentFilesToBackground(background, mockFiles);

    expect(result).toContain('## Reference Files');
    expect(result).toContain('### doc.md');
    expect(result).toContain('```markdown');
    expect(result).toContain('# Test Documentation');
    expect(result).toContain('## Overview');
    expect(result).toContain('- Feature 1');
  });

  it('should process .markdown files correctly', async () => {
    const mockFiles = [
      {
        id: 'file1',
        name: 'guide.markdown',
        file_path: 'guide.markdown',
        file_type: 'markdown'
      }
    ];

    const background = 'Initial background';
    const result = await fileProcessingService.appendAgentFilesToBackground(background, mockFiles);

    expect(result).toContain('## Reference Files');
    expect(result).toContain('### guide.markdown');
    expect(result).toContain('```markdown');
    expect(result).toContain('# User Guide');
    expect(result).toContain('Welcome to our application!');
  });

  it('should process both CSV and Markdown files together', async () => {
    const mockFiles = [
      {
        id: 'file1',
        name: 'test.csv',
        file_path: 'test.csv',
        file_type: 'csv'
      },
      {
        id: 'file2',
        name: 'doc.md',
        file_path: 'doc.md',
        file_type: 'md'
      }
    ];

    const background = 'Initial background';
    const result = await fileProcessingService.appendAgentFilesToBackground(background, mockFiles);

    // Should contain both files
    expect(result).toContain('### test.csv');
    expect(result).toContain('```csv');
    expect(result).toContain('### doc.md');
    expect(result).toContain('```markdown');
    expect(result).toContain('id,name,value');
    expect(result).toContain('# Test Documentation');
  });

  it('should detect Markdown files by extension', async () => {
    const mockFiles = [
      {
        id: 'file1',
        name: 'readme.md',
        file_path: 'readme.md',
        file_type: 'unknown' // file_type doesn't indicate markdown
      }
    ];

    const background = 'Initial background';
    const result = await fileProcessingService.appendAgentFilesToBackground(background, mockFiles);

    expect(result).toContain('### readme.md');
    expect(result).toContain('```markdown');
    expect(DatabaseAdapter.getAgentFileContent).toHaveBeenCalledWith('readme.md');
  });

  it('should handle files that are not CSV or Markdown as references', async () => {
    const mockFiles = [
      {
        id: 'file1',
        name: 'data.txt',
        file_path: 'data.txt',
        file_type: 'text'
      }
    ];

    const background = 'Initial background';
    const result = await fileProcessingService.appendAgentFilesToBackground(background, mockFiles);

    expect(result).toContain('### data.txt');
    expect(result).toContain('Reference file of type: text');
    expect(result).not.toContain('```');
  });

  it('should process JSON files correctly', async () => {
    const mockFiles = [
      {
        id: 'file1',
        name: 'config.json',
        file_path: 'config.json',
        file_type: 'json'
      }
    ];

    const background = 'Initial background';
    const result = await fileProcessingService.appendAgentFilesToBackground(background, mockFiles);

    expect(result).toContain('## Reference Files');
    expect(result).toContain('### config.json');
    expect(result).toContain('```json');
    expect(result).toContain('"name": "test-app"');
    expect(result).toContain('"version": "1.0.0"');
    expect(result).toContain('"debug": true');
  });

  it('should process TXT files correctly', async () => {
    const mockFiles = [
      {
        id: 'file1',
        name: 'notes.txt',
        file_path: 'notes.txt',
        file_type: 'txt'
      }
    ];

    const background = 'Initial background';
    const result = await fileProcessingService.appendAgentFilesToBackground(background, mockFiles);

    expect(result).toContain('## Reference Files');
    expect(result).toContain('### notes.txt');
    expect(result).toContain('```text');
    expect(result).toContain('Estas son las notas importantes');
    expect(result).toContain('Configuración:');
    expect(result).toContain('admin@example.com');
  });

  it('should process YAML files correctly', async () => {
    const mockFiles = [
      {
        id: 'file1',
        name: 'docker-compose.yml',
        file_path: 'docker-compose.yml',
        file_type: 'yaml'
      }
    ];

    const background = 'Initial background';
    const result = await fileProcessingService.appendAgentFilesToBackground(background, mockFiles);

    expect(result).toContain('## Reference Files');
    expect(result).toContain('### docker-compose.yml');
    expect(result).toContain('```yaml');
    expect(result).toContain('version: \'3.8\'');
    expect(result).toContain('services:');
    expect(result).toContain('image: node:16');
  });

  it('should process mixed file types correctly', async () => {
    const mockFiles = [
      {
        id: 'file1',
        name: 'test.csv',
        file_path: 'test.csv',
        file_type: 'csv'
      },
      {
        id: 'file2',
        name: 'config.json',
        file_path: 'config.json',
        file_type: 'json'
      },
      {
        id: 'file3',
        name: 'notes.txt',
        file_path: 'notes.txt',
        file_type: 'txt'
      },
      {
        id: 'file4',
        name: 'docker-compose.yml',
        file_path: 'docker-compose.yml',
        file_type: 'yaml'
      }
    ];

    const background = 'Initial background';
    const result = await fileProcessingService.appendAgentFilesToBackground(background, mockFiles);

    // Should contain all file types
    expect(result).toContain('### test.csv');
    expect(result).toContain('```csv');
    expect(result).toContain('### config.json');
    expect(result).toContain('```json');
    expect(result).toContain('### notes.txt');
    expect(result).toContain('```text');
    expect(result).toContain('### docker-compose.yml');
    expect(result).toContain('```yaml');
    
    // Should contain content from all files
    expect(result).toContain('id,name,value');
    expect(result).toContain('"name": "test-app"');
    expect(result).toContain('Estas son las notas');
    expect(result).toContain('version: \'3.8\'');
  });

  it('should detect JSON files by extension', async () => {
    const mockFiles = [
      {
        id: 'file1',
        name: 'settings.json',
        file_path: 'settings.json',
        file_type: 'unknown' // file_type doesn't indicate json
      }
    ];

    const background = 'Initial background';
    const result = await fileProcessingService.appendAgentFilesToBackground(background, mockFiles);

    expect(result).toContain('### settings.json');
    expect(result).toContain('```json');
    expect(DatabaseAdapter.getAgentFileContent).toHaveBeenCalledWith('settings.json');
  });

  it('should detect YAML files by .yml extension', async () => {
    const mockFiles = [
      {
        id: 'file1',
        name: 'config.yml',
        file_path: 'config.yml',
        file_type: 'unknown' // file_type doesn't indicate yaml
      }
    ];

    const background = 'Initial background';
    const result = await fileProcessingService.appendAgentFilesToBackground(background, mockFiles);

    expect(result).toContain('### config.yml');
    expect(result).toContain('```yaml');
    expect(DatabaseAdapter.getAgentFileContent).toHaveBeenCalledWith('config.yml');
  });

  it('should handle empty file list', async () => {
    const background = 'Initial background';
    const result = await fileProcessingService.appendAgentFilesToBackground(background, []);

    expect(result).toBe('Initial background');
  });
}); 