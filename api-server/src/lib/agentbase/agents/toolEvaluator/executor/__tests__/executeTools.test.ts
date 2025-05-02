import { jest } from '@jest/globals';
import axios from 'axios';
import { executeTools } from '../executeTools';
import * as customToolsMap from '../customToolsMap';
import { FunctionCall, FunctionCallStatus } from '../../types';

// Mock modules
jest.mock('axios');
jest.mock('../customToolsMap', () => ({
  hasCustomTool: jest.fn(),
  getCustomToolDefinition: jest.fn()
}));

// Mock process.env
const originalEnv = process.env;

// Create a typed mock for axios
const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('executeTools', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Crear una copia de process.env para cada test
    process.env = { ...originalEnv };
  });
  
  afterEach(() => {
    // Restaurar process.env original después de cada test
    process.env = originalEnv;
  });

  it('should transform local URLs to 127.0.0.1 URLs with default port', async () => {
    // Configurar el entorno para este test (sin afectar al original)
    jest.spyOn(process, 'env', 'get').mockReturnValue({
      ...originalEnv,
      NODE_ENV: 'development',
      PORT: undefined,
      API_BASE_URL: undefined
    });
    
    // Setup mocks
    (customToolsMap.hasCustomTool as jest.Mock).mockReturnValue(true);
    (customToolsMap.getCustomToolDefinition as jest.Mock).mockReturnValue({
      endpoint: {
        url: '/api/test',
        method: 'GET',
        headers: {
          'Content-Type': 'application/json'
        }
      },
      responseMapping: {
        result: 'data'
      }
    });

    // Mock axios response
    mockedAxios.get.mockImplementation(() => 
      Promise.resolve({ 
        data: { data: 'test result' }
      } as any)
    );

    // Execute the tool
    const functionCalls: FunctionCall[] = [
      {
        id: 'test-1',
        type: 'function',
        status: FunctionCallStatus.INITIALIZED,
        name: 'TEST_TOOL',
        arguments: '{}'
      }
    ];
    
    const result = await executeTools(functionCalls, {});

    // Verify axios was called with the transformed URL with default port 3000 using IPv4
    expect(mockedAxios.get).toHaveBeenCalledWith(
      'http://127.0.0.1:3000/api/test',
      expect.any(Object)
    );

    // Verify the result is as expected
    expect(result[0].status).toBe('success');
    expect(result[0].output).toEqual({ result: 'test result' });
  });
  
  it('should handle IPv6 ::1 connection refused errors', async () => {
    // Configurar el entorno para este test
    jest.spyOn(process, 'env', 'get').mockReturnValue({
      ...originalEnv,
      NODE_ENV: 'development',
      PORT: '8080', // Este valor será ignorado para esta prueba específica
      API_BASE_URL: undefined
    });
    
    // Setup mocks para la herramienta
    (customToolsMap.hasCustomTool as jest.Mock).mockReturnValue(true);
    (customToolsMap.getCustomToolDefinition as jest.Mock).mockReturnValue({
      endpoint: {
        url: '/api/test',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        }
      },
      responseMapping: {
        result: 'data'
      }
    });

    // Primera respuesta: error IPv6 ::1 de conexión rechazada
    const ipv6Error = new Error('connect ECONNREFUSED ::1:8080') as any;
    ipv6Error.code = 'ECONNREFUSED';
    ipv6Error.errno = -61;
    ipv6Error.syscall = 'connect';
    ipv6Error.address = '::1';
    ipv6Error.port = 8080;
    ipv6Error.config = { url: 'http://[::1]:8080/api/test' };

    // Respuesta exitosa para el reintento
    const successResponse = { 
      data: { data: 'test result from IPv4' }
    } as any;

    // Configurar el comportamiento de mock para axios.post
    // 1. Primer intento: falla con IPv6 error
    // 2. Segundo intento: exitoso con 127.0.0.1:3000
    mockedAxios.post
      .mockRejectedValueOnce(ipv6Error)
      .mockResolvedValueOnce(successResponse);

    // Execute the tool
    const functionCalls: FunctionCall[] = [
      {
        id: 'test-ipv6',
        type: 'function',
        status: FunctionCallStatus.INITIALIZED,
        name: 'TEST_TOOL',
        arguments: '{}'
      }
    ];
    
    const result = await executeTools(functionCalls, {});

    // Verificar que se usó alguna alternativa después del fallo
    expect(mockedAxios.post).toHaveBeenCalledTimes(2);
    
    // La primera llamada debería haber sido a la URL original
    expect(mockedAxios.post.mock.calls[0][0]).toMatch(/127\.0\.0\.1|localhost|::1/);
    
    // Verificar que el resultado es exitoso
    expect(result[0].status).toBe('success');
    expect(result[0].output).toEqual({ result: 'test result from IPv4' });
  });
  
  it('should retry with alternative ports on ECONNREFUSED error', async () => {
    // Configurar el entorno para este test
    jest.spyOn(process, 'env', 'get').mockReturnValue({
      ...originalEnv,
      NODE_ENV: 'development',
      PORT: '3001',
      API_BASE_URL: undefined
    });
    
    // Setup mocks
    (customToolsMap.hasCustomTool as jest.Mock).mockReturnValue(true);
    (customToolsMap.getCustomToolDefinition as jest.Mock).mockReturnValue({
      endpoint: {
        url: '/api/test',
        method: 'GET',
        headers: {
          'Content-Type': 'application/json'
        }
      },
      responseMapping: {
        result: 'data'
      }
    });

    // Simular fallo en la primera llamada a 3001, pero éxito en 3000
    mockedAxios.get
      // Primer llamada (puerto 3001) - error de conexión rechazada
      .mockImplementationOnce(() => { 
        const error: any = new Error('Connection refused');
        error.code = 'ECONNREFUSED';
        error.config = { url: 'http://127.0.0.1:3001/api/test' };
        return Promise.reject(error);
      })
      // Segunda llamada (puerto 3000) - éxito
      .mockImplementationOnce(() => 
        Promise.resolve({ 
          data: { data: 'test result from alternative port' }
        } as any)
      );

    // Execute the tool
    const functionCalls: FunctionCall[] = [
      {
        id: 'test-retry',
        type: 'function',
        status: FunctionCallStatus.INITIALIZED,
        name: 'TEST_TOOL',
        arguments: '{}'
      }
    ];
    
    const result = await executeTools(functionCalls, {});

    // Verificar que se intentó con el puerto 3001 primero
    expect(mockedAxios.get).toHaveBeenCalledWith(
      'http://127.0.0.1:3001/api/test',
      expect.any(Object)
    );
    
    // La segunda llamada debería ser con un host/puerto alternativo
    // No comprobamos la URL exacta porque depende del orden de las alternativas
    expect(mockedAxios.get).toHaveBeenCalledTimes(2);

    // Verificar que el resultado es del segundo intento exitoso
    expect(result[0].status).toBe('success');
    expect(result[0].output).toEqual({ result: 'test result from alternative port' });
  });
  
  it('should use API_BASE_URL in production', async () => {
    // Configurar el entorno para este test
    jest.spyOn(process, 'env', 'get').mockReturnValue({
      ...originalEnv,
      NODE_ENV: 'production',
      API_BASE_URL: 'https://api.ejemplo.com'
    });
    
    // Setup mocks
    (customToolsMap.hasCustomTool as jest.Mock).mockReturnValue(true);
    (customToolsMap.getCustomToolDefinition as jest.Mock).mockReturnValue({
      endpoint: {
        url: '/api/test',
        method: 'GET',
        headers: {
          'Content-Type': 'application/json'
        }
      },
      responseMapping: {
        result: 'data'
      }
    });

    // Mock axios response
    mockedAxios.get.mockImplementation(() => 
      Promise.resolve({ 
        data: { data: 'test result' }
      } as any)
    );

    // Execute the tool
    const functionCalls: FunctionCall[] = [
      {
        id: 'test-production',
        type: 'function',
        status: FunctionCallStatus.INITIALIZED,
        name: 'TEST_TOOL',
        arguments: '{}'
      }
    ];
    
    const result = await executeTools(functionCalls, {});

    // Verify axios was called with the production URL
    expect(mockedAxios.get).toHaveBeenCalledWith(
      'https://api.ejemplo.com/api/test',
      expect.any(Object)
    );

    // Verify the result is as expected
    expect(result[0].status).toBe('success');
    expect(result[0].output).toEqual({ result: 'test result' });
  });

  it('should not transform absolute URLs', async () => {
    // Setup mocks
    (customToolsMap.hasCustomTool as jest.Mock).mockReturnValue(true);
    (customToolsMap.getCustomToolDefinition as jest.Mock).mockReturnValue({
      endpoint: {
        url: 'https://api.example.com/test',
        method: 'GET',
        headers: {
          'Content-Type': 'application/json'
        }
      },
      responseMapping: {
        result: 'data'
      }
    });

    // Mock axios response
    mockedAxios.get.mockImplementation(() => 
      Promise.resolve({ 
        data: { data: 'test result' }
      } as any)
    );

    // Execute the tool
    const functionCalls: FunctionCall[] = [
      {
        id: 'test-2',
        type: 'function',
        status: FunctionCallStatus.INITIALIZED,
        name: 'TEST_TOOL',
        arguments: '{}'
      }
    ];
    
    const result = await executeTools(functionCalls, {});

    // Verify axios was called with the original URL
    expect(mockedAxios.get).toHaveBeenCalledWith(
      'https://api.example.com/test',
      expect.any(Object)
    );

    // Verify the result is as expected
    expect(result[0].status).toBe('success');
    expect(result[0].output).toEqual({ result: 'test result' });
  });
}); 