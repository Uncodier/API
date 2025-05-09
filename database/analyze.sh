#!/bin/bash
# Script para analizar el esquema de la base de datos

# Colores para mensajes
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Función para mostrar mensajes
function log_info() {
  echo -e "${BLUE}[INFO]${NC} $1"
}

function log_success() {
  echo -e "${GREEN}[ÉXITO]${NC} $1"
}

function log_warning() {
  echo -e "${YELLOW}[ADVERTENCIA]${NC} $1"
}

function log_error() {
  echo -e "${RED}[ERROR]${NC} $1"
}

# Encabezado
echo -e "${GREEN}=======================================================${NC}"
echo -e "${GREEN}      Analizador de Esquema de Base de Datos Supabase   ${NC}"
echo -e "${GREEN}=======================================================${NC}"
echo

# Verificar que estamos en el directorio correcto
if [ ! -f "analyze.sh" ]; then
  log_error "Este script debe ejecutarse desde el directorio 'database'"
  log_info "Ejecute: cd database && ./analyze.sh"
  exit 1
fi

# Verificar que el archivo schema.sql existe
if [ ! -f "schema.sql" ]; then
  log_error "No se encontró el archivo schema.sql"
  log_info "Por favor, siga estos pasos:"
  echo "  1. Inicie sesión en su panel de control de Supabase"
  echo "  2. Vaya a la sección 'SQL Editor'"
  echo "  3. Copie y pegue la consulta del archivo schema.sql original"
  echo "  4. Ejecute la consulta"
  echo "  5. Copie los resultados JSON y guárdelos en el archivo schema.sql"
  exit 1
fi

# Verificar si el archivo contiene JSON
if ! grep -q "\[\s*{" schema.sql && ! grep -q "^\[" schema.sql; then
  log_warning "El archivo schema.sql no parece contener datos JSON."
  log_info "Asegúrese de que ha reemplazado la consulta SQL con el resultado JSON."
  echo "¿Desea continuar de todos modos? (s/n)"
  read -r response
  if [[ "$response" != "s" ]]; then
    exit 1
  fi
fi

# Hacer una copia de seguridad del archivo schema.sql
log_info "Haciendo copia de seguridad del archivo schema.sql..."
cp schema.sql schema.sql.bak
log_success "Copia de seguridad creada: schema.sql.bak"

# Determinar qué analizador usar
echo
log_info "¿Qué analizador desea utilizar?"
echo "  1) JavaScript (requiere Node.js)"
echo "  2) Python (requiere Python 3)"
echo "  3) Ambos"
read -r choice

case $choice in
  1)
    log_info "Ejecutando analizador JavaScript..."
    if command -v node &> /dev/null; then
      node schema_analyzer.js
      if [ $? -eq 0 ]; then
        log_success "Análisis JavaScript completado con éxito."
      else
        log_error "El análisis JavaScript falló."
      fi
    else
      log_error "Node.js no está instalado. Por favor, instale Node.js e intente de nuevo."
      exit 1
    fi
    ;;
  2)
    log_info "Ejecutando analizador Python..."
    if command -v python3 &> /dev/null; then
      python3 schema_analyzer.py
      if [ $? -eq 0 ]; then
        log_success "Análisis Python completado con éxito."
      else
        log_error "El análisis Python falló."
      fi
    elif command -v python &> /dev/null; then
      python schema_analyzer.py
      if [ $? -eq 0 ]; then
        log_success "Análisis Python completado con éxito."
      else
        log_error "El análisis Python falló."
      fi
    else
      log_error "Python no está instalado. Por favor, instale Python e intente de nuevo."
      exit 1
    fi
    ;;
  3)
    log_info "Ejecutando ambos analizadores..."
    
    if command -v node &> /dev/null; then
      log_info "Ejecutando analizador JavaScript..."
      node schema_analyzer.js
      if [ $? -eq 0 ]; then
        log_success "Análisis JavaScript completado con éxito."
      else
        log_error "El análisis JavaScript falló."
      fi
    else
      log_warning "Node.js no está instalado. No se pudo ejecutar el analizador JavaScript."
    fi
    
    if command -v python3 &> /dev/null; then
      log_info "Ejecutando analizador Python..."
      python3 schema_analyzer.py
      if [ $? -eq 0 ]; then
        log_success "Análisis Python completado con éxito."
      else
        log_error "El análisis Python falló."
      fi
    elif command -v python &> /dev/null; then
      log_info "Ejecutando analizador Python..."
      python schema_analyzer.py
      if [ $? -eq 0 ]; then
        log_success "Análisis Python completado con éxito."
      else
        log_error "El análisis Python falló."
      fi
    else
      log_warning "Python no está instalado. No se pudo ejecutar el analizador Python."
    fi
    ;;
  *)
    log_error "Opción no válida. Saliendo."
    exit 1
    ;;
esac

echo
log_info "Archivos generados:"

if [ -f "schema_summary.md" ]; then
  log_success "- schema_summary.md: Resumen detallado del esquema"
fi

if [ -f "schema_relations.md" ]; then
  log_success "- schema_relations.md: Diagrama de relaciones entre tablas"
fi

if [ -f "schema_stats.json" ]; then
  log_success "- schema_stats.json: Estadísticas del esquema en formato JSON"
fi

echo
log_success "Análisis completado."
log_info "Puede abrir los archivos .md en un editor que soporte Markdown para visualizarlos." 