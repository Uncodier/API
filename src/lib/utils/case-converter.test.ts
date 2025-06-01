/**
 * Tests para CaseConverterService
 */

import {
  camelToSnake,
  snakeToCamel,
  objectKeysToSnake,
  objectKeysToCamel,
  getFlexibleProperty,
  setFlexibleProperty,
  CaseConverterService
} from './case-converter';

describe('CaseConverterService', () => {
  describe('camelToSnake', () => {
    test('convierte camelCase a snake_case', () => {
      expect(camelToSnake('userId')).toBe('user_id');
      expect(camelToSnake('teamMemberId')).toBe('team_member_id');
      expect(camelToSnake('siteId')).toBe('site_id');
      expect(camelToSnake('analysisType')).toBe('analysis_type');
    });

    test('maneja cadenas que ya están en minúsculas', () => {
      expect(camelToSnake('email')).toBe('email');
      expect(camelToSnake('name')).toBe('name');
    });
  });

  describe('snakeToCamel', () => {
    test('convierte snake_case a camelCase', () => {
      expect(snakeToCamel('user_id')).toBe('userId');
      expect(snakeToCamel('team_member_id')).toBe('teamMemberId');
      expect(snakeToCamel('site_id')).toBe('siteId');
      expect(snakeToCamel('analysis_type')).toBe('analysisType');
    });

    test('maneja cadenas sin guiones bajos', () => {
      expect(snakeToCamel('email')).toBe('email');
      expect(snakeToCamel('name')).toBe('name');
    });
  });

  describe('objectKeysToSnake', () => {
    test('convierte claves de objeto a snake_case', () => {
      const input = {
        userId: '123',
        teamMemberId: '456',
        analysisType: 'lead',
        userInfo: {
          firstName: 'John',
          lastName: 'Doe'
        }
      };

      const expected = {
        user_id: '123',
        team_member_id: '456',
        analysis_type: 'lead',
        user_info: {
          first_name: 'John',
          last_name: 'Doe'
        }
      };

      expect(objectKeysToSnake(input)).toEqual(expected);
    });

    test('maneja arrays con objetos', () => {
      const input = {
        userList: [
          { userId: '1', firstName: 'John' },
          { userId: '2', firstName: 'Jane' }
        ]
      };

      const expected = {
        user_list: [
          { user_id: '1', first_name: 'John' },
          { user_id: '2', first_name: 'Jane' }
        ]
      };

      expect(objectKeysToSnake(input)).toEqual(expected);
    });
  });

  describe('objectKeysToCamel', () => {
    test('convierte claves de objeto a camelCase', () => {
      const input = {
        user_id: '123',
        team_member_id: '456',
        analysis_type: 'lead',
        user_info: {
          first_name: 'John',
          last_name: 'Doe'
        }
      };

      const expected = {
        userId: '123',
        teamMemberId: '456',
        analysisType: 'lead',
        userInfo: {
          firstName: 'John',
          lastName: 'Doe'
        }
      };

      expect(objectKeysToCamel(input)).toEqual(expected);
    });
  });

  describe('getFlexibleProperty', () => {
    const testObj = {
      userId: '123',
      team_member_id: '456',
      email: 'test@example.com'
    };

    test('encuentra propiedad con nombre exacto', () => {
      expect(getFlexibleProperty(testObj, 'email')).toBe('test@example.com');
    });

    test('encuentra propiedad convirtiendo a camelCase', () => {
      expect(getFlexibleProperty(testObj, 'team_member_id')).toBe('456');
    });

    test('encuentra propiedad convirtiendo a snake_case', () => {
      expect(getFlexibleProperty(testObj, 'user_id')).toBe('123');
    });

    test('retorna undefined si no encuentra la propiedad', () => {
      expect(getFlexibleProperty(testObj, 'nonexistent')).toBeUndefined();
    });
  });

  describe('CaseConverterService.normalizeRequestData', () => {
    test('normaliza a snake_case por defecto', () => {
      const input = { userId: '123', teamMemberId: '456' };
      const result = CaseConverterService.normalizeRequestData(input);
      
      expect(result).toEqual({
        user_id: '123',
        team_member_id: '456'
      });
    });

    test('normaliza a camelCase cuando se especifica', () => {
      const input = { user_id: '123', team_member_id: '456' };
      const result = CaseConverterService.normalizeRequestData(input, 'camel');
      
      expect(result).toEqual({
        userId: '123',
        teamMemberId: '456'
      });
    });
  });

  describe('CaseConverterService.hasRequiredProperties', () => {
    const testObj = {
      userId: '123',
      team_member_id: '456',
      email: 'test@example.com'
    };

    test('retorna true cuando todas las propiedades están presentes', () => {
      const result = CaseConverterService.hasRequiredProperties(
        testObj, 
        ['user_id', 'team_member_id', 'email']
      );
      expect(result).toBe(true);
    });

    test('retorna false cuando falta alguna propiedad', () => {
      const result = CaseConverterService.hasRequiredProperties(
        testObj, 
        ['user_id', 'missing_property']
      );
      expect(result).toBe(false);
    });
  });

  describe('CaseConverterService.mapFlexibleProperties', () => {
    test('mapea propiedades con nombres flexibles', () => {
      const sourceObj = {
        userId: '123',
        team_member_id: '456',
        userEmail: 'test@example.com'
      };

      const mapping = {
        id: ['userId', 'user_id', 'id'],
        memberId: ['teamMemberId', 'team_member_id'],
        email: ['userEmail', 'user_email', 'email']
      };

      const result = CaseConverterService.mapFlexibleProperties(mapping, sourceObj);

      expect(result).toEqual({
        id: '123',
        memberId: '456',
        email: 'test@example.com'
      });
    });
  });
}); 