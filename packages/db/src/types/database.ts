export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.4"
  }
  public: {
    Tables: {
      agencies: {
        Row: {
          acronym: string | null
          agency_type: string
          contact_email: string | null
          created_at: string
          description: string | null
          governing_body_id: string | null
          id: string
          is_active: boolean
          jurisdiction_id: string
          metadata: Json
          name: string
          parent_agency_id: string | null
          short_name: string | null
          source_ids: Json
          updated_at: string
          usaspending_agency_id: string | null
          usaspending_subtier_id: string | null
          website_url: string | null
        }
        Insert: {
          acronym?: string | null
          agency_type?: string
          contact_email?: string | null
          created_at?: string
          description?: string | null
          governing_body_id?: string | null
          id?: string
          is_active?: boolean
          jurisdiction_id: string
          metadata?: Json
          name: string
          parent_agency_id?: string | null
          short_name?: string | null
          source_ids?: Json
          updated_at?: string
          usaspending_agency_id?: string | null
          usaspending_subtier_id?: string | null
          website_url?: string | null
        }
        Update: {
          acronym?: string | null
          agency_type?: string
          contact_email?: string | null
          created_at?: string
          description?: string | null
          governing_body_id?: string | null
          id?: string
          is_active?: boolean
          jurisdiction_id?: string
          metadata?: Json
          name?: string
          parent_agency_id?: string | null
          short_name?: string | null
          source_ids?: Json
          updated_at?: string
          usaspending_agency_id?: string | null
          usaspending_subtier_id?: string | null
          website_url?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "agencies_governing_body_id_fkey"
            columns: ["governing_body_id"]
            isOneToOne: false
            referencedRelation: "governing_bodies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agencies_jurisdiction_id_fkey"
            columns: ["jurisdiction_id"]
            isOneToOne: false
            referencedRelation: "jurisdictions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agencies_parent_agency_id_fkey"
            columns: ["parent_agency_id"]
            isOneToOne: false
            referencedRelation: "agencies"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_summary_cache: {
        Row: {
          created_at: string
          entity_id: string
          entity_type: string
          id: string
          model: string
          summary_text: string
          summary_type: string
          tokens_used: number | null
        }
        Insert: {
          created_at?: string
          entity_id: string
          entity_type: string
          id?: string
          model: string
          summary_text: string
          summary_type: string
          tokens_used?: number | null
        }
        Update: {
          created_at?: string
          entity_id?: string
          entity_type?: string
          id?: string
          model?: string
          summary_text?: string
          summary_type?: string
          tokens_used?: number | null
        }
        Relationships: []
      }
      api_usage_logs: {
        Row: {
          cost_cents: number
          created_at: string
          endpoint: string | null
          id: string
          input_tokens: number | null
          metadata: Json
          model: string | null
          output_tokens: number | null
          service: string
          tokens_used: number | null
        }
        Insert: {
          cost_cents?: number
          created_at?: string
          endpoint?: string | null
          id?: string
          input_tokens?: number | null
          metadata?: Json
          model?: string | null
          output_tokens?: number | null
          service: string
          tokens_used?: number | null
        }
        Update: {
          cost_cents?: number
          created_at?: string
          endpoint?: string | null
          id?: string
          input_tokens?: number | null
          metadata?: Json
          model?: string | null
          output_tokens?: number | null
          service?: string
          tokens_used?: number | null
        }
        Relationships: []
      }
      career_history: {
        Row: {
          created_at: string
          ended_at: string | null
          governing_body_id: string | null
          id: string
          is_government: boolean
          metadata: Json
          official_id: string
          organization: string
          revolving_door_explanation: string | null
          revolving_door_flag: boolean
          role_title: string | null
          started_at: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          ended_at?: string | null
          governing_body_id?: string | null
          id?: string
          is_government?: boolean
          metadata?: Json
          official_id: string
          organization: string
          revolving_door_explanation?: string | null
          revolving_door_flag?: boolean
          role_title?: string | null
          started_at?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          ended_at?: string | null
          governing_body_id?: string | null
          id?: string
          is_government?: boolean
          metadata?: Json
          official_id?: string
          organization?: string
          revolving_door_explanation?: string | null
          revolving_door_flag?: boolean
          role_title?: string | null
          started_at?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "career_history_governing_body_id_fkey"
            columns: ["governing_body_id"]
            isOneToOne: false
            referencedRelation: "governing_bodies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "career_history_official_id_fkey"
            columns: ["official_id"]
            isOneToOne: false
            referencedRelation: "officials"
            referencedColumns: ["id"]
          },
        ]
      }
      civic_comments: {
        Row: {
          body: string
          created_at: string
          id: string
          is_deleted: boolean
          metadata: Json
          onchain_tx_hash: string | null
          parent_id: string | null
          position: string | null
          proposal_id: string
          updated_at: string
          upvotes: number
          user_id: string
        }
        Insert: {
          body: string
          created_at?: string
          id?: string
          is_deleted?: boolean
          metadata?: Json
          onchain_tx_hash?: string | null
          parent_id?: string | null
          position?: string | null
          proposal_id: string
          updated_at?: string
          upvotes?: number
          user_id: string
        }
        Update: {
          body?: string
          created_at?: string
          id?: string
          is_deleted?: boolean
          metadata?: Json
          onchain_tx_hash?: string | null
          parent_id?: string | null
          position?: string | null
          proposal_id?: string
          updated_at?: string
          upvotes?: number
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "civic_comments_parent_id_fkey"
            columns: ["parent_id"]
            isOneToOne: false
            referencedRelation: "civic_comments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "civic_comments_proposal_id_fkey"
            columns: ["proposal_id"]
            isOneToOne: false
            referencedRelation: "proposals"
            referencedColumns: ["id"]
          },
        ]
      }
      civic_credit_transactions: {
        Row: {
          amount: number
          balance_after: number
          created_at: string
          description: string | null
          id: string
          onchain_tx_hash: string | null
          related_entity_id: string | null
          related_entity_type: string | null
          transaction_type: string
          user_id: string
        }
        Insert: {
          amount: number
          balance_after: number
          created_at?: string
          description?: string | null
          id?: string
          onchain_tx_hash?: string | null
          related_entity_id?: string | null
          related_entity_type?: string | null
          transaction_type: string
          user_id: string
        }
        Update: {
          amount?: number
          balance_after?: number
          created_at?: string
          description?: string | null
          id?: string
          onchain_tx_hash?: string | null
          related_entity_id?: string | null
          related_entity_type?: string | null
          transaction_type?: string
          user_id?: string
        }
        Relationships: []
      }
      data_sync_log: {
        Row: {
          completed_at: string | null
          created_at: string
          error_message: string | null
          estimated_mb: number | null
          id: string
          pipeline: string
          rows_failed: number
          rows_inserted: number
          rows_updated: number
          started_at: string
          status: string
        }
        Insert: {
          completed_at?: string | null
          created_at?: string
          error_message?: string | null
          estimated_mb?: number | null
          id?: string
          pipeline: string
          rows_failed?: number
          rows_inserted?: number
          rows_updated?: number
          started_at?: string
          status?: string
        }
        Update: {
          completed_at?: string | null
          created_at?: string
          error_message?: string | null
          estimated_mb?: number | null
          id?: string
          pipeline?: string
          rows_failed?: number
          rows_inserted?: number
          rows_updated?: number
          started_at?: string
          status?: string
        }
        Relationships: []
      }
      entity_connections: {
        Row: {
          amount_cents: number | null
          connection_type: Database["public"]["Enums"]["connection_type"]
          created_at: string
          ended_at: string | null
          evidence: Json
          from_id: string
          from_type: string
          id: string
          is_verified: boolean
          metadata: Json
          occurred_at: string | null
          strength: number
          to_id: string
          to_type: string
          updated_at: string
        }
        Insert: {
          amount_cents?: number | null
          connection_type: Database["public"]["Enums"]["connection_type"]
          created_at?: string
          ended_at?: string | null
          evidence?: Json
          from_id: string
          from_type: string
          id?: string
          is_verified?: boolean
          metadata?: Json
          occurred_at?: string | null
          strength?: number
          to_id: string
          to_type: string
          updated_at?: string
        }
        Update: {
          amount_cents?: number | null
          connection_type?: Database["public"]["Enums"]["connection_type"]
          created_at?: string
          ended_at?: string | null
          evidence?: Json
          from_id?: string
          from_type?: string
          id?: string
          is_verified?: boolean
          metadata?: Json
          occurred_at?: string | null
          strength?: number
          to_id?: string
          to_type?: string
          updated_at?: string
        }
        Relationships: []
      }
      entity_tags: {
        Row: {
          ai_model: string | null
          confidence: number | null
          created_at: string | null
          display_icon: string | null
          display_label: string
          entity_id: string
          entity_type: string
          generated_by: string
          id: string
          metadata: Json | null
          pipeline_version: string | null
          tag: string
          tag_category: string
          visibility: string
        }
        Insert: {
          ai_model?: string | null
          confidence?: number | null
          created_at?: string | null
          display_icon?: string | null
          display_label: string
          entity_id: string
          entity_type: string
          generated_by: string
          id?: string
          metadata?: Json | null
          pipeline_version?: string | null
          tag: string
          tag_category: string
          visibility?: string
        }
        Update: {
          ai_model?: string | null
          confidence?: number | null
          created_at?: string | null
          display_icon?: string | null
          display_label?: string
          entity_id?: string
          entity_type?: string
          generated_by?: string
          id?: string
          metadata?: Json | null
          pipeline_version?: string | null
          tag?: string
          tag_category?: string
          visibility?: string
        }
        Relationships: []
      }
      financial_entities: {
        Row: {
          created_at: string
          entity_type: string
          id: string
          industry: string | null
          metadata: Json
          name: string
          source_ids: Json
          total_donated_cents: number
          updated_at: string
        }
        Insert: {
          created_at?: string
          entity_type: string
          id?: string
          industry?: string | null
          metadata?: Json
          name: string
          source_ids?: Json
          total_donated_cents?: number
          updated_at?: string
        }
        Update: {
          created_at?: string
          entity_type?: string
          id?: string
          industry?: string | null
          metadata?: Json
          name?: string
          source_ids?: Json
          total_donated_cents?: number
          updated_at?: string
        }
        Relationships: []
      }
      financial_relationships: {
        Row: {
          amount_cents: number
          contribution_date: string | null
          created_at: string
          cycle_year: number | null
          donor_name: string
          donor_type: Database["public"]["Enums"]["donor_type"]
          fec_committee_id: string | null
          fec_filing_id: string | null
          governing_body_id: string | null
          id: string
          industry: string | null
          is_bundled: boolean
          metadata: Json
          official_id: string | null
          source_ids: Json
          source_url: string | null
          updated_at: string
        }
        Insert: {
          amount_cents: number
          contribution_date?: string | null
          created_at?: string
          cycle_year?: number | null
          donor_name: string
          donor_type: Database["public"]["Enums"]["donor_type"]
          fec_committee_id?: string | null
          fec_filing_id?: string | null
          governing_body_id?: string | null
          id?: string
          industry?: string | null
          is_bundled?: boolean
          metadata?: Json
          official_id?: string | null
          source_ids?: Json
          source_url?: string | null
          updated_at?: string
        }
        Update: {
          amount_cents?: number
          contribution_date?: string | null
          created_at?: string
          cycle_year?: number | null
          donor_name?: string
          donor_type?: Database["public"]["Enums"]["donor_type"]
          fec_committee_id?: string | null
          fec_filing_id?: string | null
          governing_body_id?: string | null
          id?: string
          industry?: string | null
          is_bundled?: boolean
          metadata?: Json
          official_id?: string | null
          source_ids?: Json
          source_url?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "financial_relationships_governing_body_id_fkey"
            columns: ["governing_body_id"]
            isOneToOne: false
            referencedRelation: "governing_bodies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "financial_relationships_official_id_fkey"
            columns: ["official_id"]
            isOneToOne: false
            referencedRelation: "officials"
            referencedColumns: ["id"]
          },
        ]
      }
      governing_bodies: {
        Row: {
          contact_email: string | null
          created_at: string
          id: string
          is_active: boolean
          jurisdiction_id: string
          metadata: Json
          name: string
          seat_count: number | null
          short_name: string | null
          term_length_years: number | null
          type: Database["public"]["Enums"]["governing_body_type"]
          updated_at: string
          website_url: string | null
        }
        Insert: {
          contact_email?: string | null
          created_at?: string
          id?: string
          is_active?: boolean
          jurisdiction_id: string
          metadata?: Json
          name: string
          seat_count?: number | null
          short_name?: string | null
          term_length_years?: number | null
          type: Database["public"]["Enums"]["governing_body_type"]
          updated_at?: string
          website_url?: string | null
        }
        Update: {
          contact_email?: string | null
          created_at?: string
          id?: string
          is_active?: boolean
          jurisdiction_id?: string
          metadata?: Json
          name?: string
          seat_count?: number | null
          short_name?: string | null
          term_length_years?: number | null
          type?: Database["public"]["Enums"]["governing_body_type"]
          updated_at?: string
          website_url?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "governing_bodies_jurisdiction_id_fkey"
            columns: ["jurisdiction_id"]
            isOneToOne: false
            referencedRelation: "jurisdictions"
            referencedColumns: ["id"]
          },
        ]
      }
      graph_snapshots: {
        Row: {
          code: string
          created_at: string | null
          created_by: string | null
          id: string
          is_public: boolean | null
          state: Json
          title: string | null
          view_count: number | null
        }
        Insert: {
          code: string
          created_at?: string | null
          created_by?: string | null
          id?: string
          is_public?: boolean | null
          state: Json
          title?: string | null
          view_count?: number | null
        }
        Update: {
          code?: string
          created_at?: string | null
          created_by?: string | null
          id?: string
          is_public?: boolean | null
          state?: Json
          title?: string | null
          view_count?: number | null
        }
        Relationships: []
      }
      jurisdictions: {
        Row: {
          boundary_geometry: unknown
          census_geoid: string | null
          centroid: unknown
          country_code: string | null
          created_at: string
          fips_code: string | null
          id: string
          is_active: boolean
          metadata: Json
          name: string
          parent_id: string | null
          population: number | null
          short_name: string | null
          timezone: string | null
          type: Database["public"]["Enums"]["jurisdiction_type"]
          updated_at: string
        }
        Insert: {
          boundary_geometry?: unknown
          census_geoid?: string | null
          centroid?: unknown
          country_code?: string | null
          created_at?: string
          fips_code?: string | null
          id?: string
          is_active?: boolean
          metadata?: Json
          name: string
          parent_id?: string | null
          population?: number | null
          short_name?: string | null
          timezone?: string | null
          type: Database["public"]["Enums"]["jurisdiction_type"]
          updated_at?: string
        }
        Update: {
          boundary_geometry?: unknown
          census_geoid?: string | null
          centroid?: unknown
          country_code?: string | null
          created_at?: string
          fips_code?: string | null
          id?: string
          is_active?: boolean
          metadata?: Json
          name?: string
          parent_id?: string | null
          population?: number | null
          short_name?: string | null
          timezone?: string | null
          type?: Database["public"]["Enums"]["jurisdiction_type"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "jurisdictions_parent_id_fkey"
            columns: ["parent_id"]
            isOneToOne: false
            referencedRelation: "jurisdictions"
            referencedColumns: ["id"]
          },
        ]
      }
      official_comment_submissions: {
        Row: {
          ai_assisted: boolean
          arweave_tx: string | null
          comment_text: string
          confirmation_number: string | null
          created_at: string
          id: string
          metadata: Json
          proposal_id: string
          regulations_gov_id: string | null
          submission_status: string
          submitted_at: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          ai_assisted?: boolean
          arweave_tx?: string | null
          comment_text: string
          confirmation_number?: string | null
          created_at?: string
          id?: string
          metadata?: Json
          proposal_id: string
          regulations_gov_id?: string | null
          submission_status?: string
          submitted_at?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          ai_assisted?: boolean
          arweave_tx?: string | null
          comment_text?: string
          confirmation_number?: string | null
          created_at?: string
          id?: string
          metadata?: Json
          proposal_id?: string
          regulations_gov_id?: string | null
          submission_status?: string
          submitted_at?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "official_comment_submissions_proposal_id_fkey"
            columns: ["proposal_id"]
            isOneToOne: false
            referencedRelation: "proposals"
            referencedColumns: ["id"]
          },
        ]
      }
      officials: {
        Row: {
          created_at: string
          district_name: string | null
          email: string | null
          first_name: string | null
          full_name: string
          governing_body_id: string
          id: string
          is_active: boolean
          is_verified: boolean
          jurisdiction_id: string
          last_name: string | null
          metadata: Json
          office_address: string | null
          party: Database["public"]["Enums"]["party"] | null
          phone: string | null
          photo_url: string | null
          role_title: string
          source_ids: Json
          term_end: string | null
          term_start: string | null
          updated_at: string
          website_url: string | null
        }
        Insert: {
          created_at?: string
          district_name?: string | null
          email?: string | null
          first_name?: string | null
          full_name: string
          governing_body_id: string
          id?: string
          is_active?: boolean
          is_verified?: boolean
          jurisdiction_id: string
          last_name?: string | null
          metadata?: Json
          office_address?: string | null
          party?: Database["public"]["Enums"]["party"] | null
          phone?: string | null
          photo_url?: string | null
          role_title: string
          source_ids?: Json
          term_end?: string | null
          term_start?: string | null
          updated_at?: string
          website_url?: string | null
        }
        Update: {
          created_at?: string
          district_name?: string | null
          email?: string | null
          first_name?: string | null
          full_name?: string
          governing_body_id?: string
          id?: string
          is_active?: boolean
          is_verified?: boolean
          jurisdiction_id?: string
          last_name?: string | null
          metadata?: Json
          office_address?: string | null
          party?: Database["public"]["Enums"]["party"] | null
          phone?: string | null
          photo_url?: string | null
          role_title?: string
          source_ids?: Json
          term_end?: string | null
          term_start?: string | null
          updated_at?: string
          website_url?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "officials_governing_body_id_fkey"
            columns: ["governing_body_id"]
            isOneToOne: false
            referencedRelation: "governing_bodies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "officials_jurisdiction_id_fkey"
            columns: ["jurisdiction_id"]
            isOneToOne: false
            referencedRelation: "jurisdictions"
            referencedColumns: ["id"]
          },
        ]
      }
      page_views: {
        Row: {
          bot_name: string | null
          browser: string | null
          country_code: string | null
          device_type: string | null
          entity_id: string | null
          entity_type: string | null
          id: string
          is_bot: boolean | null
          page: string
          referrer: string | null
          session_id: string | null
          viewed_at: string | null
        }
        Insert: {
          bot_name?: string | null
          browser?: string | null
          country_code?: string | null
          device_type?: string | null
          entity_id?: string | null
          entity_type?: string | null
          id?: string
          is_bot?: boolean | null
          page: string
          referrer?: string | null
          session_id?: string | null
          viewed_at?: string | null
        }
        Update: {
          bot_name?: string | null
          browser?: string | null
          country_code?: string | null
          device_type?: string | null
          entity_id?: string | null
          entity_type?: string | null
          id?: string
          is_bot?: boolean | null
          page?: string
          referrer?: string | null
          session_id?: string | null
          viewed_at?: string | null
        }
        Relationships: []
      }
      pipeline_state: {
        Row: {
          key: string
          updated_at: string | null
          value: Json
        }
        Insert: {
          key: string
          updated_at?: string | null
          value?: Json
        }
        Update: {
          key?: string
          updated_at?: string | null
          value?: Json
        }
        Relationships: []
      }
      promises: {
        Row: {
          arweave_tx: string | null
          created_at: string
          deadline: string | null
          description: string | null
          id: string
          jurisdiction_id: string
          made_at: string | null
          metadata: Json
          official_id: string
          onchain_tx_hash: string | null
          related_proposal_id: string | null
          resolved_at: string | null
          source_quote: string | null
          source_url: string | null
          status: Database["public"]["Enums"]["promise_status"]
          title: string
          updated_at: string
        }
        Insert: {
          arweave_tx?: string | null
          created_at?: string
          deadline?: string | null
          description?: string | null
          id?: string
          jurisdiction_id: string
          made_at?: string | null
          metadata?: Json
          official_id: string
          onchain_tx_hash?: string | null
          related_proposal_id?: string | null
          resolved_at?: string | null
          source_quote?: string | null
          source_url?: string | null
          status?: Database["public"]["Enums"]["promise_status"]
          title: string
          updated_at?: string
        }
        Update: {
          arweave_tx?: string | null
          created_at?: string
          deadline?: string | null
          description?: string | null
          id?: string
          jurisdiction_id?: string
          made_at?: string | null
          metadata?: Json
          official_id?: string
          onchain_tx_hash?: string | null
          related_proposal_id?: string | null
          resolved_at?: string | null
          source_quote?: string | null
          source_url?: string | null
          status?: Database["public"]["Enums"]["promise_status"]
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "promises_jurisdiction_id_fkey"
            columns: ["jurisdiction_id"]
            isOneToOne: false
            referencedRelation: "jurisdictions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "promises_official_id_fkey"
            columns: ["official_id"]
            isOneToOne: false
            referencedRelation: "officials"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "promises_related_proposal_id_fkey"
            columns: ["related_proposal_id"]
            isOneToOne: false
            referencedRelation: "proposals"
            referencedColumns: ["id"]
          },
        ]
      }
      proposals: {
        Row: {
          bill_number: string | null
          comment_period_end: string | null
          comment_period_start: string | null
          congress_gov_url: string | null
          congress_number: number | null
          created_at: string
          enacted_at: string | null
          fiscal_impact_cents: number | null
          full_text_arweave: string | null
          full_text_r2_key: string | null
          full_text_url: string | null
          governing_body_id: string | null
          id: string
          introduced_at: string | null
          jurisdiction_id: string
          last_action_at: string | null
          metadata: Json
          regulations_gov_id: string | null
          search_vector: unknown
          session: string | null
          short_title: string | null
          source_ids: Json
          status: Database["public"]["Enums"]["proposal_status"]
          summary_generated_at: string | null
          summary_model: string | null
          summary_plain: string | null
          title: string
          type: Database["public"]["Enums"]["proposal_type"]
          updated_at: string
        }
        Insert: {
          bill_number?: string | null
          comment_period_end?: string | null
          comment_period_start?: string | null
          congress_gov_url?: string | null
          congress_number?: number | null
          created_at?: string
          enacted_at?: string | null
          fiscal_impact_cents?: number | null
          full_text_arweave?: string | null
          full_text_r2_key?: string | null
          full_text_url?: string | null
          governing_body_id?: string | null
          id?: string
          introduced_at?: string | null
          jurisdiction_id: string
          last_action_at?: string | null
          metadata?: Json
          regulations_gov_id?: string | null
          search_vector?: unknown
          session?: string | null
          short_title?: string | null
          source_ids?: Json
          status?: Database["public"]["Enums"]["proposal_status"]
          summary_generated_at?: string | null
          summary_model?: string | null
          summary_plain?: string | null
          title: string
          type: Database["public"]["Enums"]["proposal_type"]
          updated_at?: string
        }
        Update: {
          bill_number?: string | null
          comment_period_end?: string | null
          comment_period_start?: string | null
          congress_gov_url?: string | null
          congress_number?: number | null
          created_at?: string
          enacted_at?: string | null
          fiscal_impact_cents?: number | null
          full_text_arweave?: string | null
          full_text_r2_key?: string | null
          full_text_url?: string | null
          governing_body_id?: string | null
          id?: string
          introduced_at?: string | null
          jurisdiction_id?: string
          last_action_at?: string | null
          metadata?: Json
          regulations_gov_id?: string | null
          search_vector?: unknown
          session?: string | null
          short_title?: string | null
          source_ids?: Json
          status?: Database["public"]["Enums"]["proposal_status"]
          summary_generated_at?: string | null
          summary_model?: string | null
          summary_plain?: string | null
          title?: string
          type?: Database["public"]["Enums"]["proposal_type"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "proposals_governing_body_id_fkey"
            columns: ["governing_body_id"]
            isOneToOne: false
            referencedRelation: "governing_bodies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "proposals_jurisdiction_id_fkey"
            columns: ["jurisdiction_id"]
            isOneToOne: false
            referencedRelation: "jurisdictions"
            referencedColumns: ["id"]
          },
        ]
      }
      service_usage: {
        Row: {
          count: number
          created_at: string
          id: string
          metadata: Json
          metric: string
          period: string
          service: string
        }
        Insert: {
          count?: number
          created_at?: string
          id?: string
          metadata?: Json
          metric: string
          period: string
          service: string
        }
        Update: {
          count?: number
          created_at?: string
          id?: string
          metadata?: Json
          metric?: string
          period?: string
          service?: string
        }
        Relationships: []
      }
      spending_records: {
        Row: {
          amount_cents: number
          award_date: string | null
          award_type: string | null
          awarding_agency: string
          cfda_number: string | null
          created_at: string
          description: string | null
          id: string
          jurisdiction_id: string
          metadata: Json
          naics_code: string | null
          period_of_performance_end: string | null
          period_of_performance_start: string | null
          recipient_location_jurisdiction_id: string | null
          recipient_name: string
          source_ids: Json
          total_amount_cents: number | null
          updated_at: string
          usaspending_award_id: string | null
        }
        Insert: {
          amount_cents: number
          award_date?: string | null
          award_type?: string | null
          awarding_agency: string
          cfda_number?: string | null
          created_at?: string
          description?: string | null
          id?: string
          jurisdiction_id: string
          metadata?: Json
          naics_code?: string | null
          period_of_performance_end?: string | null
          period_of_performance_start?: string | null
          recipient_location_jurisdiction_id?: string | null
          recipient_name: string
          source_ids?: Json
          total_amount_cents?: number | null
          updated_at?: string
          usaspending_award_id?: string | null
        }
        Update: {
          amount_cents?: number
          award_date?: string | null
          award_type?: string | null
          awarding_agency?: string
          cfda_number?: string | null
          created_at?: string
          description?: string | null
          id?: string
          jurisdiction_id?: string
          metadata?: Json
          naics_code?: string | null
          period_of_performance_end?: string | null
          period_of_performance_start?: string | null
          recipient_location_jurisdiction_id?: string | null
          recipient_name?: string
          source_ids?: Json
          total_amount_cents?: number | null
          updated_at?: string
          usaspending_award_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "spending_records_jurisdiction_id_fkey"
            columns: ["jurisdiction_id"]
            isOneToOne: false
            referencedRelation: "jurisdictions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "spending_records_recipient_location_jurisdiction_id_fkey"
            columns: ["recipient_location_jurisdiction_id"]
            isOneToOne: false
            referencedRelation: "jurisdictions"
            referencedColumns: ["id"]
          },
        ]
      }
      users: {
        Row: {
          auth_provider: string | null
          avatar_url: string | null
          civic_credits_balance: number | null
          created_at: string | null
          display_name: string | null
          email: string | null
          id: string
          is_active: boolean | null
          last_seen: string | null
          metadata: Json | null
          updated_at: string | null
        }
        Insert: {
          auth_provider?: string | null
          avatar_url?: string | null
          civic_credits_balance?: number | null
          created_at?: string | null
          display_name?: string | null
          email?: string | null
          id: string
          is_active?: boolean | null
          last_seen?: string | null
          metadata?: Json | null
          updated_at?: string | null
        }
        Update: {
          auth_provider?: string | null
          avatar_url?: string | null
          civic_credits_balance?: number | null
          created_at?: string | null
          display_name?: string | null
          email?: string | null
          id?: string
          is_active?: boolean | null
          last_seen?: string | null
          metadata?: Json | null
          updated_at?: string | null
        }
        Relationships: []
      }
      votes: {
        Row: {
          chamber: string | null
          created_at: string
          id: string
          metadata: Json
          official_id: string
          proposal_id: string
          roll_call_number: string | null
          session: string | null
          source_ids: Json
          updated_at: string
          vote: string
          voted_at: string | null
        }
        Insert: {
          chamber?: string | null
          created_at?: string
          id?: string
          metadata?: Json
          official_id: string
          proposal_id: string
          roll_call_number?: string | null
          session?: string | null
          source_ids?: Json
          updated_at?: string
          vote: string
          voted_at?: string | null
        }
        Update: {
          chamber?: string | null
          created_at?: string
          id?: string
          metadata?: Json
          official_id?: string
          proposal_id?: string
          roll_call_number?: string | null
          session?: string | null
          source_ids?: Json
          updated_at?: string
          vote?: string
          voted_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "votes_official_id_fkey"
            columns: ["official_id"]
            isOneToOne: false
            referencedRelation: "officials"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "votes_proposal_id_fkey"
            columns: ["proposal_id"]
            isOneToOne: false
            referencedRelation: "proposals"
            referencedColumns: ["id"]
          },
        ]
      }
      warrant_canary: {
        Row: {
          block_number: number | null
          chain: string
          created_at: string
          id: string
          onchain_tx_hash: string | null
          published_at: string
          signature: string | null
          statement_text: string
        }
        Insert: {
          block_number?: number | null
          chain?: string
          created_at?: string
          id?: string
          onchain_tx_hash?: string | null
          published_at: string
          signature?: string | null
          statement_text: string
        }
        Update: {
          block_number?: number | null
          chain?: string
          created_at?: string
          id?: string
          onchain_tx_hash?: string | null
          published_at?: string
          signature?: string | null
          statement_text?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      find_jurisdictions_by_location: {
        Args: { user_lat: number; user_lng: number }
        Returns: {
          id: string
          name: string
          short_name: string
          type: Database["public"]["Enums"]["jurisdiction_type"]
        }[]
      }
      find_representatives_by_location: {
        Args: { user_lat: number; user_lng: number }
        Returns: {
          full_name: string
          governing_body: string
          id: string
          jurisdiction: string
          party: Database["public"]["Enums"]["party"]
          role_title: string
        }[]
      }
      get_database_size_bytes: { Args: never; Returns: number }
      get_pac_donations_by_party: {
        Args: never
        Returns: {
          party:          string
          donor_name:     string
          total_usd:      number
          donation_count: number
        }[]
      }
      get_official_donors: {
        Args: { p_official_id: string }
        Returns: {
          financial_entity_id: string | null
          entity_name: string
          entity_type: string
          industry_category: string
          total_amount_usd: number
          transaction_count: number
        }[]
      }
      get_officials_breakdown: {
        Args: never
        Returns: {
          category: string
          count: number
        }[]
      }
      get_pv_bots: {
        Args: never
        Returns: {
          count: number
          visitor_type: string
        }[]
      }
      get_pv_countries: {
        Args: { lim?: number }
        Returns: {
          count: number
          country_code: string
        }[]
      }
      get_pv_devices: {
        Args: never
        Returns: {
          count: number
          device_type: string
        }[]
      }
      get_pv_sources: {
        Args: never
        Returns: {
          referrer: string
          visits: number
        }[]
      }
      get_pv_summary: {
        Args: never
        Returns: {
          bot_views: number
          human_views: number
          total_views: number
        }[]
      }
      get_pv_top_officials: {
        Args: { lim?: number }
        Returns: {
          full_name: string
          official_id: string
          role_title: string
          views: number
        }[]
      }
      get_pv_top_pages: {
        Args: { lim?: number }
        Returns: {
          page: string
          unique_sessions: number
          views: number
        }[]
      }
      get_pv_top_proposals: {
        Args: { lim?: number }
        Returns: {
          proposal_id: string
          title: string
          views: number
        }[]
      }
      increment_service_usage: {
        Args: { p_metric: string; p_period: string; p_service: string }
        Returns: undefined
      }
      increment_snapshot_view: { Args: { p_code: string }; Returns: undefined }
      search_graph_entities: {
        Args: { lim?: number; q: string }
        Returns: {
          entity_type: string
          id: string
          label: string
          party: string
          subtitle: string
        }[]
      }
      treemap_officials_by_donations: {
        Args: { lim?: number }
        Returns: {
          official_id: string
          official_name: string
          party: string
          state: string
          chamber: string
          total_donated_cents: number
        }[]
      }
    }
    Enums: {
      connection_type:
        | "donation"
        | "vote_yes"
        | "vote_no"
        | "vote_abstain"
        | "nomination_vote_yes"
        | "nomination_vote_no"
        | "appointment"
        | "revolving_door"
        | "oversight"
        | "lobbying"
        | "co_sponsorship"
        | "family"
        | "business_partner"
        | "legal_representation"
        | "endorsement"
        | "contract_award"
      donor_type:
        | "individual"
        | "pac"
        | "super_pac"
        | "corporate"
        | "union"
        | "party_committee"
        | "small_donor_aggregate"
        | "other"
      governing_body_type:
        | "legislature_upper"
        | "legislature_lower"
        | "legislature_unicameral"
        | "executive"
        | "judicial"
        | "regulatory_agency"
        | "municipal_council"
        | "school_board"
        | "special_district"
        | "international_body"
        | "other"
      jurisdiction_type:
        | "global"
        | "supranational"
        | "country"
        | "state"
        | "county"
        | "city"
        | "district"
        | "precinct"
        | "other"
      party:
        | "democrat"
        | "republican"
        | "independent"
        | "libertarian"
        | "green"
        | "other"
        | "nonpartisan"
      promise_status:
        | "made"
        | "in_progress"
        | "kept"
        | "broken"
        | "partially_kept"
        | "expired"
        | "modified"
      proposal_status:
        | "introduced"
        | "in_committee"
        | "passed_committee"
        | "floor_vote"
        | "passed_chamber"
        | "passed_both_chambers"
        | "signed"
        | "vetoed"
        | "veto_overridden"
        | "enacted"
        | "open_comment"
        | "comment_closed"
        | "final_rule"
        | "failed"
        | "withdrawn"
        | "tabled"
      proposal_type:
        | "bill"
        | "resolution"
        | "amendment"
        | "regulation"
        | "executive_order"
        | "treaty"
        | "referendum"
        | "initiative"
        | "budget"
        | "appointment"
        | "ordinance"
        | "other"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      connection_type: [
        "donation",
        "vote_yes",
        "vote_no",
        "vote_abstain",
        "nomination_vote_yes",
        "nomination_vote_no",
        "appointment",
        "revolving_door",
        "oversight",
        "lobbying",
        "co_sponsorship",
        "family",
        "business_partner",
        "legal_representation",
        "endorsement",
        "contract_award",
      ],
      donor_type: [
        "individual",
        "pac",
        "super_pac",
        "corporate",
        "union",
        "party_committee",
        "small_donor_aggregate",
        "other",
      ],
      governing_body_type: [
        "legislature_upper",
        "legislature_lower",
        "legislature_unicameral",
        "executive",
        "judicial",
        "regulatory_agency",
        "municipal_council",
        "school_board",
        "special_district",
        "international_body",
        "other",
      ],
      jurisdiction_type: [
        "global",
        "supranational",
        "country",
        "state",
        "county",
        "city",
        "district",
        "precinct",
        "other",
      ],
      party: [
        "democrat",
        "republican",
        "independent",
        "libertarian",
        "green",
        "other",
        "nonpartisan",
      ],
      promise_status: [
        "made",
        "in_progress",
        "kept",
        "broken",
        "partially_kept",
        "expired",
        "modified",
      ],
      proposal_status: [
        "introduced",
        "in_committee",
        "passed_committee",
        "floor_vote",
        "passed_chamber",
        "passed_both_chambers",
        "signed",
        "vetoed",
        "veto_overridden",
        "enacted",
        "open_comment",
        "comment_closed",
        "final_rule",
        "failed",
        "withdrawn",
        "tabled",
      ],
      proposal_type: [
        "bill",
        "resolution",
        "amendment",
        "regulation",
        "executive_order",
        "treaty",
        "referendum",
        "initiative",
        "budget",
        "appointment",
        "ordinance",
        "other",
      ],
    },
  },
} as const
