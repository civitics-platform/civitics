export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
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
          founded_year: number | null
          governing_body_id: string | null
          id: string
          is_active: boolean
          jurisdiction_id: string
          metadata: Json
          name: string
          parent_agency_id: string | null
          personnel_fte: number | null
          primary_source: string | null
          primary_source_last_seen_at: string | null
          primary_source_url: string | null
          short_name: string | null
          source_ids: Json
          updated_at: string
          usaspending_agency_id: string | null
          usaspending_subtier_id: string | null
          website_url: string | null
          wikidata_id: string | null
        }
        Insert: {
          acronym?: string | null
          agency_type?: string
          contact_email?: string | null
          created_at?: string
          description?: string | null
          founded_year?: number | null
          governing_body_id?: string | null
          id?: string
          is_active?: boolean
          jurisdiction_id: string
          metadata?: Json
          name: string
          parent_agency_id?: string | null
          personnel_fte?: number | null
          primary_source?: string | null
          primary_source_last_seen_at?: string | null
          primary_source_url?: string | null
          short_name?: string | null
          source_ids?: Json
          updated_at?: string
          usaspending_agency_id?: string | null
          usaspending_subtier_id?: string | null
          website_url?: string | null
          wikidata_id?: string | null
        }
        Update: {
          acronym?: string | null
          agency_type?: string
          contact_email?: string | null
          created_at?: string
          description?: string | null
          founded_year?: number | null
          governing_body_id?: string | null
          id?: string
          is_active?: boolean
          jurisdiction_id?: string
          metadata?: Json
          name?: string
          parent_agency_id?: string | null
          personnel_fte?: number | null
          primary_source?: string | null
          primary_source_last_seen_at?: string | null
          primary_source_url?: string | null
          short_name?: string | null
          source_ids?: Json
          updated_at?: string
          usaspending_agency_id?: string | null
          usaspending_subtier_id?: string | null
          website_url?: string | null
          wikidata_id?: string | null
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
      agenda_items: {
        Row: {
          created_at: string
          description: string | null
          id: string
          item_type: string | null
          meeting_id: string
          metadata: Json
          outcome: string | null
          proposal_id: string | null
          sequence: number
          title: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          description?: string | null
          id?: string
          item_type?: string | null
          meeting_id: string
          metadata?: Json
          outcome?: string | null
          proposal_id?: string | null
          sequence: number
          title: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          description?: string | null
          id?: string
          item_type?: string | null
          meeting_id?: string
          metadata?: Json
          outcome?: string | null
          proposal_id?: string | null
          sequence?: number
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "agenda_items_meeting_id_fkey"
            columns: ["meeting_id"]
            isOneToOne: false
            referencedRelation: "meetings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agenda_items_proposal_id_fkey"
            columns: ["proposal_id"]
            isOneToOne: false
            referencedRelation: "proposal_trending_24h"
            referencedColumns: ["proposal_id"]
          },
          {
            foreignKeyName: "agenda_items_proposal_id_fkey"
            columns: ["proposal_id"]
            isOneToOne: false
            referencedRelation: "proposals"
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
          metadata: Json
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
          metadata?: Json
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
          metadata?: Json
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
      bill_details: {
        Row: {
          bill_number: string
          chamber: string | null
          congress_gov_url: string | null
          congress_number: number | null
          fiscal_impact_cents: number | null
          jurisdiction_id: string
          legistar_matter_id: string | null
          primary_sponsor_id: string | null
          proposal_id: string
          session: string | null
        }
        Insert: {
          bill_number: string
          chamber?: string | null
          congress_gov_url?: string | null
          congress_number?: number | null
          fiscal_impact_cents?: number | null
          jurisdiction_id: string
          legistar_matter_id?: string | null
          primary_sponsor_id?: string | null
          proposal_id: string
          session?: string | null
        }
        Update: {
          bill_number?: string
          chamber?: string | null
          congress_gov_url?: string | null
          congress_number?: number | null
          fiscal_impact_cents?: number | null
          jurisdiction_id?: string
          legistar_matter_id?: string | null
          primary_sponsor_id?: string | null
          proposal_id?: string
          session?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "bill_details_primary_sponsor_id_fkey"
            columns: ["primary_sponsor_id"]
            isOneToOne: false
            referencedRelation: "official_homepage_stats_mv"
            referencedColumns: ["official_id"]
          },
          {
            foreignKeyName: "bill_details_primary_sponsor_id_fkey"
            columns: ["primary_sponsor_id"]
            isOneToOne: false
            referencedRelation: "officials"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bill_details_proposal_id_fkey"
            columns: ["proposal_id"]
            isOneToOne: true
            referencedRelation: "proposal_trending_24h"
            referencedColumns: ["proposal_id"]
          },
          {
            foreignKeyName: "bill_details_proposal_id_fkey"
            columns: ["proposal_id"]
            isOneToOne: true
            referencedRelation: "proposals"
            referencedColumns: ["id"]
          },
        ]
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
            referencedRelation: "official_homepage_stats_mv"
            referencedColumns: ["official_id"]
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
      case_details: {
        Row: {
          case_name: string | null
          court_name: string
          courtlistener_id: string | null
          docket_number: string
          filed_at: string | null
          outcome: string | null
          outcome_at: string | null
          pacer_id: string | null
          parties: Json
          proposal_id: string
        }
        Insert: {
          case_name?: string | null
          court_name: string
          courtlistener_id?: string | null
          docket_number: string
          filed_at?: string | null
          outcome?: string | null
          outcome_at?: string | null
          pacer_id?: string | null
          parties?: Json
          proposal_id: string
        }
        Update: {
          case_name?: string | null
          court_name?: string
          courtlistener_id?: string | null
          docket_number?: string
          filed_at?: string | null
          outcome?: string | null
          outcome_at?: string | null
          pacer_id?: string | null
          parties?: Json
          proposal_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "case_details_proposal_id_fkey"
            columns: ["proposal_id"]
            isOneToOne: true
            referencedRelation: "proposal_trending_24h"
            referencedColumns: ["proposal_id"]
          },
          {
            foreignKeyName: "case_details_proposal_id_fkey"
            columns: ["proposal_id"]
            isOneToOne: true
            referencedRelation: "proposals"
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
            referencedRelation: "proposal_trending_24h"
            referencedColumns: ["proposal_id"]
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
      civic_initiative_argument_flags: {
        Row: {
          argument_id: string
          created_at: string
          flag_type: Database["public"]["Enums"]["argument_flag"]
          id: string
          user_id: string
        }
        Insert: {
          argument_id: string
          created_at?: string
          flag_type?: Database["public"]["Enums"]["argument_flag"]
          id?: string
          user_id: string
        }
        Update: {
          argument_id?: string
          created_at?: string
          flag_type?: Database["public"]["Enums"]["argument_flag"]
          id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "civic_initiative_argument_flags_argument_id_fkey"
            columns: ["argument_id"]
            isOneToOne: false
            referencedRelation: "civic_initiative_arguments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "civic_initiative_argument_flags_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      civic_initiative_argument_votes: {
        Row: {
          argument_id: string
          created_at: string
          id: string
          user_id: string
        }
        Insert: {
          argument_id: string
          created_at?: string
          id?: string
          user_id: string
        }
        Update: {
          argument_id?: string
          created_at?: string
          id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "civic_initiative_argument_votes_argument_id_fkey"
            columns: ["argument_id"]
            isOneToOne: false
            referencedRelation: "civic_initiative_arguments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "civic_initiative_argument_votes_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      civic_initiative_arguments: {
        Row: {
          author_id: string | null
          body: string
          comment_type: string | null
          created_at: string
          flag_count: number
          id: string
          initiative_id: string
          is_deleted: boolean
          parent_id: string | null
          side: Database["public"]["Enums"]["argument_side"] | null
          updated_at: string
        }
        Insert: {
          author_id?: string | null
          body: string
          comment_type?: string | null
          created_at?: string
          flag_count?: number
          id?: string
          initiative_id: string
          is_deleted?: boolean
          parent_id?: string | null
          side?: Database["public"]["Enums"]["argument_side"] | null
          updated_at?: string
        }
        Update: {
          author_id?: string | null
          body?: string
          comment_type?: string | null
          created_at?: string
          flag_count?: number
          id?: string
          initiative_id?: string
          is_deleted?: boolean
          parent_id?: string | null
          side?: Database["public"]["Enums"]["argument_side"] | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "civic_initiative_arguments_author_id_fkey"
            columns: ["author_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "civic_initiative_arguments_initiative_id_fkey"
            columns: ["initiative_id"]
            isOneToOne: false
            referencedRelation: "proposal_trending_24h"
            referencedColumns: ["proposal_id"]
          },
          {
            foreignKeyName: "civic_initiative_arguments_initiative_id_fkey"
            columns: ["initiative_id"]
            isOneToOne: false
            referencedRelation: "proposals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "civic_initiative_arguments_parent_id_fkey"
            columns: ["parent_id"]
            isOneToOne: false
            referencedRelation: "civic_initiative_arguments"
            referencedColumns: ["id"]
          },
        ]
      }
      civic_initiative_follows: {
        Row: {
          created_at: string
          id: string
          initiative_id: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          initiative_id: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          initiative_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "civic_initiative_follows_initiative_id_fkey"
            columns: ["initiative_id"]
            isOneToOne: false
            referencedRelation: "proposal_trending_24h"
            referencedColumns: ["proposal_id"]
          },
          {
            foreignKeyName: "civic_initiative_follows_initiative_id_fkey"
            columns: ["initiative_id"]
            isOneToOne: false
            referencedRelation: "proposals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "civic_initiative_follows_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      civic_initiative_milestone_events: {
        Row: {
          constituent_count: number
          fired_at: string
          id: string
          initiative_id: string
          milestone: string
          total_count: number
        }
        Insert: {
          constituent_count?: number
          fired_at?: string
          id?: string
          initiative_id: string
          milestone: string
          total_count?: number
        }
        Update: {
          constituent_count?: number
          fired_at?: string
          id?: string
          initiative_id?: string
          milestone?: string
          total_count?: number
        }
        Relationships: [
          {
            foreignKeyName: "civic_initiative_milestone_events_initiative_id_fkey"
            columns: ["initiative_id"]
            isOneToOne: false
            referencedRelation: "proposal_trending_24h"
            referencedColumns: ["proposal_id"]
          },
          {
            foreignKeyName: "civic_initiative_milestone_events_initiative_id_fkey"
            columns: ["initiative_id"]
            isOneToOne: false
            referencedRelation: "proposals"
            referencedColumns: ["id"]
          },
        ]
      }
      civic_initiative_proposal_links: {
        Row: {
          created_at: string
          id: string
          initiative_id: string
          linked_by: string
          proposal_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          initiative_id: string
          linked_by: string
          proposal_id: string
        }
        Update: {
          created_at?: string
          id?: string
          initiative_id?: string
          linked_by?: string
          proposal_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "civic_initiative_proposal_links_initiative_id_fkey"
            columns: ["initiative_id"]
            isOneToOne: false
            referencedRelation: "proposal_trending_24h"
            referencedColumns: ["proposal_id"]
          },
          {
            foreignKeyName: "civic_initiative_proposal_links_initiative_id_fkey"
            columns: ["initiative_id"]
            isOneToOne: false
            referencedRelation: "proposals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "civic_initiative_proposal_links_linked_by_fkey"
            columns: ["linked_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "civic_initiative_proposal_links_proposal_id_fkey"
            columns: ["proposal_id"]
            isOneToOne: false
            referencedRelation: "proposal_trending_24h"
            referencedColumns: ["proposal_id"]
          },
          {
            foreignKeyName: "civic_initiative_proposal_links_proposal_id_fkey"
            columns: ["proposal_id"]
            isOneToOne: false
            referencedRelation: "proposals"
            referencedColumns: ["id"]
          },
        ]
      }
      civic_initiative_responses: {
        Row: {
          body_text: string | null
          committee_referred: string | null
          created_at: string
          id: string
          initiative_id: string
          is_verified_staff: boolean
          official_id: string
          responded_at: string | null
          response_type: Database["public"]["Enums"]["official_response_type"]
          window_closes_at: string
          window_opened_at: string
        }
        Insert: {
          body_text?: string | null
          committee_referred?: string | null
          created_at?: string
          id?: string
          initiative_id: string
          is_verified_staff?: boolean
          official_id: string
          responded_at?: string | null
          response_type?: Database["public"]["Enums"]["official_response_type"]
          window_closes_at?: string
          window_opened_at?: string
        }
        Update: {
          body_text?: string | null
          committee_referred?: string | null
          created_at?: string
          id?: string
          initiative_id?: string
          is_verified_staff?: boolean
          official_id?: string
          responded_at?: string | null
          response_type?: Database["public"]["Enums"]["official_response_type"]
          window_closes_at?: string
          window_opened_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "civic_initiative_responses_initiative_id_fkey"
            columns: ["initiative_id"]
            isOneToOne: false
            referencedRelation: "proposal_trending_24h"
            referencedColumns: ["proposal_id"]
          },
          {
            foreignKeyName: "civic_initiative_responses_initiative_id_fkey"
            columns: ["initiative_id"]
            isOneToOne: false
            referencedRelation: "proposals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "civic_initiative_responses_official_id_fkey"
            columns: ["official_id"]
            isOneToOne: false
            referencedRelation: "official_homepage_stats_mv"
            referencedColumns: ["official_id"]
          },
          {
            foreignKeyName: "civic_initiative_responses_official_id_fkey"
            columns: ["official_id"]
            isOneToOne: false
            referencedRelation: "officials"
            referencedColumns: ["id"]
          },
        ]
      }
      civic_initiative_signatures: {
        Row: {
          district: string | null
          id: string
          initiative_id: string
          signed_at: string
          user_id: string
          verification_tier: Database["public"]["Enums"]["signature_verification"]
        }
        Insert: {
          district?: string | null
          id?: string
          initiative_id: string
          signed_at?: string
          user_id: string
          verification_tier?: Database["public"]["Enums"]["signature_verification"]
        }
        Update: {
          district?: string | null
          id?: string
          initiative_id?: string
          signed_at?: string
          user_id?: string
          verification_tier?: Database["public"]["Enums"]["signature_verification"]
        }
        Relationships: [
          {
            foreignKeyName: "civic_initiative_signatures_initiative_id_fkey"
            columns: ["initiative_id"]
            isOneToOne: false
            referencedRelation: "proposal_trending_24h"
            referencedColumns: ["proposal_id"]
          },
          {
            foreignKeyName: "civic_initiative_signatures_initiative_id_fkey"
            columns: ["initiative_id"]
            isOneToOne: false
            referencedRelation: "proposals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "civic_initiative_signatures_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      civic_initiative_upvotes: {
        Row: {
          created_at: string
          id: string
          initiative_id: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          initiative_id: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          initiative_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "civic_initiative_upvotes_initiative_id_fkey"
            columns: ["initiative_id"]
            isOneToOne: false
            referencedRelation: "proposal_trending_24h"
            referencedColumns: ["proposal_id"]
          },
          {
            foreignKeyName: "civic_initiative_upvotes_initiative_id_fkey"
            columns: ["initiative_id"]
            isOneToOne: false
            referencedRelation: "proposals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "civic_initiative_upvotes_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      civic_initiative_versions: {
        Row: {
          body_md: string
          created_at: string
          edited_by: string | null
          id: string
          initiative_id: string
          title: string
          version_number: number
        }
        Insert: {
          body_md: string
          created_at?: string
          edited_by?: string | null
          id?: string
          initiative_id: string
          title: string
          version_number: number
        }
        Update: {
          body_md?: string
          created_at?: string
          edited_by?: string | null
          id?: string
          initiative_id?: string
          title?: string
          version_number?: number
        }
        Relationships: [
          {
            foreignKeyName: "civic_initiative_versions_edited_by_fkey"
            columns: ["edited_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "civic_initiative_versions_initiative_id_fkey"
            columns: ["initiative_id"]
            isOneToOne: false
            referencedRelation: "proposal_trending_24h"
            referencedColumns: ["proposal_id"]
          },
          {
            foreignKeyName: "civic_initiative_versions_initiative_id_fkey"
            columns: ["initiative_id"]
            isOneToOne: false
            referencedRelation: "proposals"
            referencedColumns: ["id"]
          },
        ]
      }
      claim_queue: {
        Row: {
          created_at: string
          id: string
          jurisdiction_id: string
          reason: string | null
          rejection_reason: string | null
          requested_by: string
          resolved_at: string | null
          status: string
          upvote_count: number
        }
        Insert: {
          created_at?: string
          id?: string
          jurisdiction_id: string
          reason?: string | null
          rejection_reason?: string | null
          requested_by: string
          resolved_at?: string | null
          status?: string
          upvote_count?: number
        }
        Update: {
          created_at?: string
          id?: string
          jurisdiction_id?: string
          reason?: string | null
          rejection_reason?: string | null
          requested_by?: string
          resolved_at?: string | null
          status?: string
          upvote_count?: number
        }
        Relationships: [
          {
            foreignKeyName: "claim_queue_jurisdiction_id_fkey"
            columns: ["jurisdiction_id"]
            isOneToOne: false
            referencedRelation: "jurisdictions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "claim_queue_requested_by_fkey"
            columns: ["requested_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      comment_ratings: {
        Row: {
          agree: number | null
          comment_id: string
          created_at: string
          rater_id: string
          updated_at: string
          valuable: number | null
        }
        Insert: {
          agree?: number | null
          comment_id: string
          created_at?: string
          rater_id: string
          updated_at?: string
          valuable?: number | null
        }
        Update: {
          agree?: number | null
          comment_id?: string
          created_at?: string
          rater_id?: string
          updated_at?: string
          valuable?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "comment_ratings_comment_id_fkey"
            columns: ["comment_id"]
            isOneToOne: false
            referencedRelation: "entity_comments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "comment_ratings_rater_id_fkey"
            columns: ["rater_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      connection_type_counts: {
        Row: {
          connection_type: string
          refreshed_at: string
          total: number
        }
        Insert: {
          connection_type: string
          refreshed_at?: string
          total: number
        }
        Update: {
          connection_type?: string
          refreshed_at?: string
          total?: number
        }
        Relationships: []
      }
      content_flags: {
        Row: {
          action_taken: string | null
          content_id: string
          content_type: Database["public"]["Enums"]["flag_content_type"]
          created_at: string
          id: string
          note: string | null
          reason: Database["public"]["Enums"]["flag_reason"]
          resolved: boolean
          resolved_at: string | null
          resolved_by: string | null
          user_id: string
        }
        Insert: {
          action_taken?: string | null
          content_id: string
          content_type: Database["public"]["Enums"]["flag_content_type"]
          created_at?: string
          id?: string
          note?: string | null
          reason?: Database["public"]["Enums"]["flag_reason"]
          resolved?: boolean
          resolved_at?: string | null
          resolved_by?: string | null
          user_id: string
        }
        Update: {
          action_taken?: string | null
          content_id?: string
          content_type?: Database["public"]["Enums"]["flag_content_type"]
          created_at?: string
          id?: string
          note?: string | null
          reason?: Database["public"]["Enums"]["flag_reason"]
          resolved?: boolean
          resolved_at?: string | null
          resolved_by?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "content_flags_resolved_by_fkey"
            columns: ["resolved_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "content_flags_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      data_sync_log: {
        Row: {
          completed_at: string | null
          created_at: string
          error_message: string | null
          estimated_mb: number | null
          id: string
          metadata: Json
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
          metadata?: Json
          pipeline: string
          rows_failed?: number
          rows_inserted?: number
          rows_updated?: number
          started_at?: string
          status: string
        }
        Update: {
          completed_at?: string | null
          created_at?: string
          error_message?: string | null
          estimated_mb?: number | null
          id?: string
          metadata?: Json
          pipeline?: string
          rows_failed?: number
          rows_inserted?: number
          rows_updated?: number
          started_at?: string
          status?: string
        }
        Relationships: []
      }
      edgar_companies: {
        Row: {
          canonical_name: string
          cik: string
          created_at: string
          financial_entity_id: string | null
          id: string
          metadata: Json
          name: string
          sector: string | null
          sic_code: string | null
          source_ids: Json
          state_of_inc: string | null
          ticker: string | null
          updated_at: string
        }
        Insert: {
          canonical_name: string
          cik: string
          created_at?: string
          financial_entity_id?: string | null
          id?: string
          metadata?: Json
          name: string
          sector?: string | null
          sic_code?: string | null
          source_ids?: Json
          state_of_inc?: string | null
          ticker?: string | null
          updated_at?: string
        }
        Update: {
          canonical_name?: string
          cik?: string
          created_at?: string
          financial_entity_id?: string | null
          id?: string
          metadata?: Json
          name?: string
          sector?: string | null
          sic_code?: string | null
          source_ids?: Json
          state_of_inc?: string | null
          ticker?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "edgar_companies_financial_entity_id_fkey"
            columns: ["financial_entity_id"]
            isOneToOne: false
            referencedRelation: "financial_entities"
            referencedColumns: ["id"]
          },
        ]
      }
      edgar_executive_officers: {
        Row: {
          canonical_name: string
          company_id: string
          created_at: string
          effective_year: number
          financial_entity_id: string | null
          full_name: string
          id: string
          match_confidence: string | null
          metadata: Json
          role_category: string
          source_accession: string
          source_filing_type: string
          source_ids: Json
          title: string
          total_compensation_cents: number | null
          updated_at: string
        }
        Insert: {
          canonical_name: string
          company_id: string
          created_at?: string
          effective_year: number
          financial_entity_id?: string | null
          full_name: string
          id?: string
          match_confidence?: string | null
          metadata?: Json
          role_category: string
          source_accession: string
          source_filing_type: string
          source_ids?: Json
          title: string
          total_compensation_cents?: number | null
          updated_at?: string
        }
        Update: {
          canonical_name?: string
          company_id?: string
          created_at?: string
          effective_year?: number
          financial_entity_id?: string | null
          full_name?: string
          id?: string
          match_confidence?: string | null
          metadata?: Json
          role_category?: string
          source_accession?: string
          source_filing_type?: string
          source_ids?: Json
          title?: string
          total_compensation_cents?: number | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "edgar_executive_officers_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "edgar_companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "edgar_executive_officers_financial_entity_id_fkey"
            columns: ["financial_entity_id"]
            isOneToOne: false
            referencedRelation: "financial_entities"
            referencedColumns: ["id"]
          },
        ]
      }
      edgar_major_shareholders: {
        Row: {
          accession: string
          canonical_holder_name: string
          company_id: string
          created_at: string
          event_date: string | null
          filed_at: string
          filing_type: string
          financial_entity_id: string | null
          holder_name: string
          id: string
          match_confidence: string | null
          metadata: Json
          pct_of_class: number | null
          shares_held: number | null
          source_ids: Json
          updated_at: string
        }
        Insert: {
          accession: string
          canonical_holder_name: string
          company_id: string
          created_at?: string
          event_date?: string | null
          filed_at: string
          filing_type: string
          financial_entity_id?: string | null
          holder_name: string
          id?: string
          match_confidence?: string | null
          metadata?: Json
          pct_of_class?: number | null
          shares_held?: number | null
          source_ids?: Json
          updated_at?: string
        }
        Update: {
          accession?: string
          canonical_holder_name?: string
          company_id?: string
          created_at?: string
          event_date?: string | null
          filed_at?: string
          filing_type?: string
          financial_entity_id?: string | null
          holder_name?: string
          id?: string
          match_confidence?: string | null
          metadata?: Json
          pct_of_class?: number | null
          shares_held?: number | null
          source_ids?: Json
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "edgar_major_shareholders_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "edgar_companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "edgar_major_shareholders_financial_entity_id_fkey"
            columns: ["financial_entity_id"]
            isOneToOne: false
            referencedRelation: "financial_entities"
            referencedColumns: ["id"]
          },
        ]
      }
      enrichment_queue: {
        Row: {
          claimed_at: string | null
          claimed_by: string | null
          completed_at: string | null
          context: Json | null
          created_at: string
          entity_id: string
          entity_type: string
          entity_updated_at: string
          id: number
          last_error: string | null
          priority: number
          result: Json | null
          retry_count: number
          status: string
          task_type: string
        }
        Insert: {
          claimed_at?: string | null
          claimed_by?: string | null
          completed_at?: string | null
          context?: Json | null
          created_at?: string
          entity_id: string
          entity_type: string
          entity_updated_at?: string
          id?: number
          last_error?: string | null
          priority?: number
          result?: Json | null
          retry_count?: number
          status?: string
          task_type: string
        }
        Update: {
          claimed_at?: string | null
          claimed_by?: string | null
          completed_at?: string | null
          context?: Json | null
          created_at?: string
          entity_id?: string
          entity_type?: string
          entity_updated_at?: string
          id?: number
          last_error?: string | null
          priority?: number
          result?: Json | null
          retry_count?: number
          status?: string
          task_type?: string
        }
        Relationships: []
      }
      entity_activity_state: {
        Row: {
          entity_id: string
          entity_type: string
          recent_comment_count: number
          slow_mode: boolean
          slow_mode_until: string | null
          updated_at: string
          window_start: string
        }
        Insert: {
          entity_id: string
          entity_type: string
          recent_comment_count?: number
          slow_mode?: boolean
          slow_mode_until?: string | null
          updated_at?: string
          window_start?: string
        }
        Update: {
          entity_id?: string
          entity_type?: string
          recent_comment_count?: number
          slow_mode?: boolean
          slow_mode_until?: string | null
          updated_at?: string
          window_start?: string
        }
        Relationships: []
      }
      entity_comments: {
        Row: {
          author_id: string
          body: string
          bridge_score: number | null
          conditions_md: string | null
          constituent_jurisdiction_id: string | null
          created_at: string
          entity_id: string
          entity_type: string
          id: string
          kind: string
          map_x: number | null
          map_y: number | null
          metadata: Json
          parent_id: string | null
          rating_summary: Json
          stance: string | null
          status: string
          thread_root_id: string | null
          updated_at: string
        }
        Insert: {
          author_id: string
          body: string
          bridge_score?: number | null
          conditions_md?: string | null
          constituent_jurisdiction_id?: string | null
          created_at?: string
          entity_id: string
          entity_type: string
          id?: string
          kind?: string
          map_x?: number | null
          map_y?: number | null
          metadata?: Json
          parent_id?: string | null
          rating_summary?: Json
          stance?: string | null
          status?: string
          thread_root_id?: string | null
          updated_at?: string
        }
        Update: {
          author_id?: string
          body?: string
          bridge_score?: number | null
          conditions_md?: string | null
          constituent_jurisdiction_id?: string | null
          created_at?: string
          entity_id?: string
          entity_type?: string
          id?: string
          kind?: string
          map_x?: number | null
          map_y?: number | null
          metadata?: Json
          parent_id?: string | null
          rating_summary?: Json
          stance?: string | null
          status?: string
          thread_root_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "entity_comments_author_id_fkey"
            columns: ["author_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "entity_comments_parent_id_fkey"
            columns: ["parent_id"]
            isOneToOne: false
            referencedRelation: "entity_comments"
            referencedColumns: ["id"]
          },
        ]
      }
      entity_connections: {
        Row: {
          amount_cents: number | null
          connection_type: Database["public"]["Enums"]["connection_type"]
          derived_at: string
          ended_at: string | null
          evidence_count: number
          evidence_ids: string[]
          evidence_source: string
          from_id: string
          from_type: string
          id: string
          metadata: Json
          occurred_at: string | null
          strength: number
          to_id: string
          to_type: string
        }
        Insert: {
          amount_cents?: number | null
          connection_type: Database["public"]["Enums"]["connection_type"]
          derived_at?: string
          ended_at?: string | null
          evidence_count?: number
          evidence_ids?: string[]
          evidence_source: string
          from_id: string
          from_type: string
          id?: string
          metadata?: Json
          occurred_at?: string | null
          strength?: number
          to_id: string
          to_type: string
        }
        Update: {
          amount_cents?: number | null
          connection_type?: Database["public"]["Enums"]["connection_type"]
          derived_at?: string
          ended_at?: string | null
          evidence_count?: number
          evidence_ids?: string[]
          evidence_source?: string
          from_id?: string
          from_type?: string
          id?: string
          metadata?: Json
          occurred_at?: string | null
          strength?: number
          to_id?: string
          to_type?: string
        }
        Relationships: []
      }
      entity_grants: {
        Row: {
          created_at: string
          delegated_from: string | null
          evidence_id: string | null
          expires_at: string | null
          granted_at: string | null
          granted_by: string | null
          id: string
          metadata: Json
          role: Database["public"]["Enums"]["grant_role"]
          status: Database["public"]["Enums"]["grant_status"]
          target_id: string | null
          target_type: Database["public"]["Enums"]["grant_target_type"]
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          delegated_from?: string | null
          evidence_id?: string | null
          expires_at?: string | null
          granted_at?: string | null
          granted_by?: string | null
          id?: string
          metadata?: Json
          role: Database["public"]["Enums"]["grant_role"]
          status?: Database["public"]["Enums"]["grant_status"]
          target_id?: string | null
          target_type: Database["public"]["Enums"]["grant_target_type"]
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          delegated_from?: string | null
          evidence_id?: string | null
          expires_at?: string | null
          granted_at?: string | null
          granted_by?: string | null
          id?: string
          metadata?: Json
          role?: Database["public"]["Enums"]["grant_role"]
          status?: Database["public"]["Enums"]["grant_status"]
          target_id?: string | null
          target_type?: Database["public"]["Enums"]["grant_target_type"]
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "entity_grants_delegated_from_fkey"
            columns: ["delegated_from"]
            isOneToOne: false
            referencedRelation: "entity_grants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "entity_grants_evidence_id_fkey"
            columns: ["evidence_id"]
            isOneToOne: false
            referencedRelation: "grant_evidence"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "entity_grants_granted_by_fkey"
            columns: ["granted_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "entity_grants_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      entity_positions: {
        Row: {
          conditions_md: string | null
          constituent_jurisdiction_id: string | null
          created_at: string
          entity_id: string
          entity_type: string
          stance: number
          updated_at: string
          user_id: string
        }
        Insert: {
          conditions_md?: string | null
          constituent_jurisdiction_id?: string | null
          created_at?: string
          entity_id: string
          entity_type: string
          stance: number
          updated_at?: string
          user_id: string
        }
        Update: {
          conditions_md?: string | null
          constituent_jurisdiction_id?: string | null
          created_at?: string
          entity_id?: string
          entity_type?: string
          stance?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "entity_positions_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      entity_statements: {
        Row: {
          author_id: string | null
          body: string
          constituent_jurisdiction_id: string | null
          created_at: string
          entity_id: string
          entity_type: string
          id: string
          metadata: Json
          source_comment_id: string | null
          status: string
          updated_at: string
          vote_summary: Json
        }
        Insert: {
          author_id?: string | null
          body: string
          constituent_jurisdiction_id?: string | null
          created_at?: string
          entity_id: string
          entity_type: string
          id?: string
          metadata?: Json
          source_comment_id?: string | null
          status?: string
          updated_at?: string
          vote_summary?: Json
        }
        Update: {
          author_id?: string | null
          body?: string
          constituent_jurisdiction_id?: string | null
          created_at?: string
          entity_id?: string
          entity_type?: string
          id?: string
          metadata?: Json
          source_comment_id?: string | null
          status?: string
          updated_at?: string
          vote_summary?: Json
        }
        Relationships: [
          {
            foreignKeyName: "entity_statements_author_id_fkey"
            columns: ["author_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "entity_statements_source_comment_id_fkey"
            columns: ["source_comment_id"]
            isOneToOne: false
            referencedRelation: "entity_comments"
            referencedColumns: ["id"]
          },
        ]
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
      external_relationships: {
        Row: {
          amount_cents: number | null
          connection_type: Database["public"]["Enums"]["connection_type"]
          description: string | null
          ended_at: string | null
          from_id: string
          from_type: string
          id: string
          ingested_at: string
          is_current: boolean | null
          match_confidence: string
          metadata: Json
          occurred_at: string | null
          raw_category: string
          raw_category_name: string | null
          source: string
          source_id: string
          source_updated_at: string | null
          source_url: string | null
          to_id: string
          to_type: string
        }
        Insert: {
          amount_cents?: number | null
          connection_type: Database["public"]["Enums"]["connection_type"]
          description?: string | null
          ended_at?: string | null
          from_id: string
          from_type: string
          id?: string
          ingested_at?: string
          is_current?: boolean | null
          match_confidence: string
          metadata?: Json
          occurred_at?: string | null
          raw_category: string
          raw_category_name?: string | null
          source: string
          source_id: string
          source_updated_at?: string | null
          source_url?: string | null
          to_id: string
          to_type: string
        }
        Update: {
          amount_cents?: number | null
          connection_type?: Database["public"]["Enums"]["connection_type"]
          description?: string | null
          ended_at?: string | null
          from_id?: string
          from_type?: string
          id?: string
          ingested_at?: string
          is_current?: boolean | null
          match_confidence?: string
          metadata?: Json
          occurred_at?: string | null
          raw_category?: string
          raw_category_name?: string | null
          source?: string
          source_id?: string
          source_updated_at?: string | null
          source_url?: string | null
          to_id?: string
          to_type?: string
        }
        Relationships: []
      }
      external_relationships_review_queue: {
        Row: {
          candidate_matches: Json
          created_at: string
          id: string
          reason: string
          resolution_notes: string | null
          resolved_at: string | null
          resolved_to_id: string | null
          resolved_to_type: string | null
          source: string
          source_entity_id: string | null
          source_payload: Json
          source_relationship_id: string | null
          status: string
        }
        Insert: {
          candidate_matches: Json
          created_at?: string
          id?: string
          reason: string
          resolution_notes?: string | null
          resolved_at?: string | null
          resolved_to_id?: string | null
          resolved_to_type?: string | null
          source: string
          source_entity_id?: string | null
          source_payload: Json
          source_relationship_id?: string | null
          status?: string
        }
        Update: {
          candidate_matches?: Json
          created_at?: string
          id?: string
          reason?: string
          resolution_notes?: string | null
          resolved_at?: string | null
          resolved_to_id?: string | null
          resolved_to_type?: string | null
          source?: string
          source_entity_id?: string | null
          source_payload?: Json
          source_relationship_id?: string | null
          status?: string
        }
        Relationships: []
      }
      external_source_refs: {
        Row: {
          created_at: string
          entity_id: string
          entity_type: string
          external_id: string
          id: string
          last_seen_at: string
          metadata: Json
          source: string
          source_url: string | null
        }
        Insert: {
          created_at?: string
          entity_id: string
          entity_type: string
          external_id: string
          id?: string
          last_seen_at?: string
          metadata?: Json
          source: string
          source_url?: string | null
        }
        Update: {
          created_at?: string
          entity_id?: string
          entity_type?: string
          external_id?: string
          id?: string
          last_seen_at?: string
          metadata?: Json
          source?: string
          source_url?: string | null
        }
        Relationships: []
      }
      financial_entities: {
        Row: {
          canonical_name: string
          created_at: string
          display_name: string
          donor_fingerprint: string | null
          entity_cluster_id: string | null
          entity_type: string
          fec_committee_id: string | null
          id: string
          metadata: Json
          parent_entity_id: string | null
          primary_source: string | null
          primary_source_last_seen_at: string | null
          primary_source_url: string | null
          recipient_count: number
          total_contract_cents: number
          total_donated_cents: number
          total_grant_cents: number
          total_received_cents: number
          updated_at: string
        }
        Insert: {
          canonical_name: string
          created_at?: string
          display_name: string
          donor_fingerprint?: string | null
          entity_cluster_id?: string | null
          entity_type: string
          fec_committee_id?: string | null
          id?: string
          metadata?: Json
          parent_entity_id?: string | null
          primary_source?: string | null
          primary_source_last_seen_at?: string | null
          primary_source_url?: string | null
          recipient_count?: number
          total_contract_cents?: number
          total_donated_cents?: number
          total_grant_cents?: number
          total_received_cents?: number
          updated_at?: string
        }
        Update: {
          canonical_name?: string
          created_at?: string
          display_name?: string
          donor_fingerprint?: string | null
          entity_cluster_id?: string | null
          entity_type?: string
          fec_committee_id?: string | null
          id?: string
          metadata?: Json
          parent_entity_id?: string | null
          primary_source?: string | null
          primary_source_last_seen_at?: string | null
          primary_source_url?: string | null
          recipient_count?: number
          total_contract_cents?: number
          total_donated_cents?: number
          total_grant_cents?: number
          total_received_cents?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "financial_entities_parent_entity_id_fkey"
            columns: ["parent_entity_id"]
            isOneToOne: false
            referencedRelation: "financial_entities"
            referencedColumns: ["id"]
          },
        ]
      }
      financial_relationships: {
        Row: {
          amount_cents: number | null
          created_at: string
          cycle_year: number | null
          disclosure_form_id: string | null
          ended_at: string | null
          fec_filing_id: string | null
          from_id: string
          from_type: string
          id: string
          is_bundled: boolean
          is_in_kind: boolean
          metadata: Json
          occurred_at: string | null
          relationship_type: Database["public"]["Enums"]["financial_relationship_type"]
          source_url: string | null
          started_at: string | null
          to_id: string
          to_type: string
          updated_at: string
          usaspending_award_id: string | null
        }
        Insert: {
          amount_cents?: number | null
          created_at?: string
          cycle_year?: number | null
          disclosure_form_id?: string | null
          ended_at?: string | null
          fec_filing_id?: string | null
          from_id: string
          from_type: string
          id?: string
          is_bundled?: boolean
          is_in_kind?: boolean
          metadata?: Json
          occurred_at?: string | null
          relationship_type: Database["public"]["Enums"]["financial_relationship_type"]
          source_url?: string | null
          started_at?: string | null
          to_id: string
          to_type: string
          updated_at?: string
          usaspending_award_id?: string | null
        }
        Update: {
          amount_cents?: number | null
          created_at?: string
          cycle_year?: number | null
          disclosure_form_id?: string | null
          ended_at?: string | null
          fec_filing_id?: string | null
          from_id?: string
          from_type?: string
          id?: string
          is_bundled?: boolean
          is_in_kind?: boolean
          metadata?: Json
          occurred_at?: string | null
          relationship_type?: Database["public"]["Enums"]["financial_relationship_type"]
          source_url?: string | null
          started_at?: string | null
          to_id?: string
          to_type?: string
          updated_at?: string
          usaspending_award_id?: string | null
        }
        Relationships: []
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
          primary_source: string | null
          primary_source_last_seen_at: string | null
          primary_source_url: string | null
          seat_count: number | null
          short_name: string | null
          slug: string | null
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
          primary_source?: string | null
          primary_source_last_seen_at?: string | null
          primary_source_url?: string | null
          seat_count?: number | null
          short_name?: string | null
          slug?: string | null
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
          primary_source?: string | null
          primary_source_last_seen_at?: string | null
          primary_source_url?: string | null
          seat_count?: number | null
          short_name?: string | null
          slug?: string | null
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
      grant_events: {
        Row: {
          actor_id: string | null
          event: string
          grant_id: string
          id: number
          metadata: Json
          notes: string | null
          occurred_at: string
        }
        Insert: {
          actor_id?: string | null
          event: string
          grant_id: string
          id?: number
          metadata?: Json
          notes?: string | null
          occurred_at?: string
        }
        Update: {
          actor_id?: string | null
          event?: string
          grant_id?: string
          id?: number
          metadata?: Json
          notes?: string | null
          occurred_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "grant_events_actor_id_fkey"
            columns: ["actor_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "grant_events_grant_id_fkey"
            columns: ["grant_id"]
            isOneToOne: false
            referencedRelation: "entity_grants"
            referencedColumns: ["id"]
          },
        ]
      }
      grant_evidence: {
        Row: {
          artifact_ref: string | null
          id: string
          metadata: Json
          method: Database["public"]["Enums"]["evidence_method"]
          notes: string | null
          outcome: Database["public"]["Enums"]["evidence_outcome"]
          reviewed_at: string | null
          reviewer_id: string | null
          submitted_at: string
          user_id: string
        }
        Insert: {
          artifact_ref?: string | null
          id?: string
          metadata?: Json
          method: Database["public"]["Enums"]["evidence_method"]
          notes?: string | null
          outcome?: Database["public"]["Enums"]["evidence_outcome"]
          reviewed_at?: string | null
          reviewer_id?: string | null
          submitted_at?: string
          user_id: string
        }
        Update: {
          artifact_ref?: string | null
          id?: string
          metadata?: Json
          method?: Database["public"]["Enums"]["evidence_method"]
          notes?: string | null
          outcome?: Database["public"]["Enums"]["evidence_outcome"]
          reviewed_at?: string | null
          reviewer_id?: string | null
          submitted_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "grant_evidence_reviewer_id_fkey"
            columns: ["reviewer_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "grant_evidence_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      graph_snapshots: {
        Row: {
          code: string
          created_at: string
          created_by: string | null
          id: string
          is_public: boolean
          state: Json
          title: string | null
          view_count: number
        }
        Insert: {
          code: string
          created_at?: string
          created_by?: string | null
          id?: string
          is_public?: boolean
          state: Json
          title?: string | null
          view_count?: number
        }
        Update: {
          code?: string
          created_at?: string
          created_by?: string | null
          id?: string
          is_public?: boolean
          state?: Json
          title?: string | null
          view_count?: number
        }
        Relationships: []
      }
      group_donor_rollup: {
        Row: {
          donor_entity_type: string | null
          donor_name: string | null
          financial_entity_id: string
          gb_id: string
          member_count: number
          party_key: string
          sector: string | null
          total_cents: number
        }
        Insert: {
          donor_entity_type?: string | null
          donor_name?: string | null
          financial_entity_id: string
          gb_id: string
          member_count: number
          party_key: string
          sector?: string | null
          total_cents: number
        }
        Update: {
          donor_entity_type?: string | null
          donor_name?: string | null
          financial_entity_id?: string
          gb_id?: string
          member_count?: number
          party_key?: string
          sector?: string | null
          total_cents?: number
        }
        Relationships: []
      }
      group_donor_rollup_summary: {
        Row: {
          donor_count: number
          gb_id: string
          party_key: string
          refreshed_at: string
          total_cents: number
        }
        Insert: {
          donor_count: number
          gb_id: string
          party_key: string
          refreshed_at?: string
          total_cents: number
        }
        Update: {
          donor_count?: number
          gb_id?: string
          party_key?: string
          refreshed_at?: string
          total_cents?: number
        }
        Relationships: []
      }
      industry_codes: {
        Row: {
          code: string
          label: string
          sector: string | null
          source: string
        }
        Insert: {
          code: string
          label: string
          sector?: string | null
          source?: string
        }
        Update: {
          code?: string
          label?: string
          sector?: string | null
          source?: string
        }
        Relationships: []
      }
      initiative_details: {
        Row: {
          authorship_type: Database["public"]["Enums"]["initiative_authorship"]
          body_md: string
          issue_area_tags: string[]
          mobilise_started_at: string | null
          primary_author_id: string | null
          promoted_to_proposal_id: string | null
          proposal_id: string
          quality_gate_score: Json
          resolution_type:
            | Database["public"]["Enums"]["initiative_resolution"]
            | null
          scope: Database["public"]["Enums"]["initiative_scope"]
          signature_threshold: number | null
          stage: Database["public"]["Enums"]["initiative_stage"]
          target_district: string | null
        }
        Insert: {
          authorship_type?: Database["public"]["Enums"]["initiative_authorship"]
          body_md: string
          issue_area_tags?: string[]
          mobilise_started_at?: string | null
          primary_author_id?: string | null
          promoted_to_proposal_id?: string | null
          proposal_id: string
          quality_gate_score?: Json
          resolution_type?:
            | Database["public"]["Enums"]["initiative_resolution"]
            | null
          scope?: Database["public"]["Enums"]["initiative_scope"]
          signature_threshold?: number | null
          stage?: Database["public"]["Enums"]["initiative_stage"]
          target_district?: string | null
        }
        Update: {
          authorship_type?: Database["public"]["Enums"]["initiative_authorship"]
          body_md?: string
          issue_area_tags?: string[]
          mobilise_started_at?: string | null
          primary_author_id?: string | null
          promoted_to_proposal_id?: string | null
          proposal_id?: string
          quality_gate_score?: Json
          resolution_type?:
            | Database["public"]["Enums"]["initiative_resolution"]
            | null
          scope?: Database["public"]["Enums"]["initiative_scope"]
          signature_threshold?: number | null
          stage?: Database["public"]["Enums"]["initiative_stage"]
          target_district?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "initiative_details_primary_author_id_fkey"
            columns: ["primary_author_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "initiative_details_promoted_to_proposal_id_fkey"
            columns: ["promoted_to_proposal_id"]
            isOneToOne: false
            referencedRelation: "proposal_trending_24h"
            referencedColumns: ["proposal_id"]
          },
          {
            foreignKeyName: "initiative_details_promoted_to_proposal_id_fkey"
            columns: ["promoted_to_proposal_id"]
            isOneToOne: false
            referencedRelation: "proposals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "initiative_details_proposal_id_fkey"
            columns: ["proposal_id"]
            isOneToOne: true
            referencedRelation: "proposal_trending_24h"
            referencedColumns: ["proposal_id"]
          },
          {
            foreignKeyName: "initiative_details_proposal_id_fkey"
            columns: ["proposal_id"]
            isOneToOne: true
            referencedRelation: "proposals"
            referencedColumns: ["id"]
          },
        ]
      }
      institution_extensions: {
        Row: {
          acronym: string | null
          created_at: string
          governing_body_id: string
          metadata: Json
          parent_id: string | null
          updated_at: string
          usaspending_agency_id: string | null
          usaspending_subtier_id: string | null
        }
        Insert: {
          acronym?: string | null
          created_at?: string
          governing_body_id: string
          metadata?: Json
          parent_id?: string | null
          updated_at?: string
          usaspending_agency_id?: string | null
          usaspending_subtier_id?: string | null
        }
        Update: {
          acronym?: string | null
          created_at?: string
          governing_body_id?: string
          metadata?: Json
          parent_id?: string | null
          updated_at?: string
          usaspending_agency_id?: string | null
          usaspending_subtier_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "institution_extensions_governing_body_id_fkey"
            columns: ["governing_body_id"]
            isOneToOne: true
            referencedRelation: "governing_bodies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "institution_extensions_parent_id_fkey"
            columns: ["parent_id"]
            isOneToOne: false
            referencedRelation: "governing_bodies"
            referencedColumns: ["id"]
          },
        ]
      }
      irs990_filings: {
        Row: {
          address_state: string | null
          created_at: string
          ein: string
          fetched_at: string
          filing_type: string
          financial_entity_id: string
          id: string
          metadata: Json
          ntee_code: string | null
          object_id: string
          schema_version: string | null
          source_url: string
          subsection_code: number | null
          tax_year: number
          total_assets_eoy_cents: number | null
          total_expenses_cents: number | null
          total_revenue_cents: number | null
          updated_at: string
        }
        Insert: {
          address_state?: string | null
          created_at?: string
          ein: string
          fetched_at?: string
          filing_type: string
          financial_entity_id: string
          id?: string
          metadata?: Json
          ntee_code?: string | null
          object_id: string
          schema_version?: string | null
          source_url: string
          subsection_code?: number | null
          tax_year: number
          total_assets_eoy_cents?: number | null
          total_expenses_cents?: number | null
          total_revenue_cents?: number | null
          updated_at?: string
        }
        Update: {
          address_state?: string | null
          created_at?: string
          ein?: string
          fetched_at?: string
          filing_type?: string
          financial_entity_id?: string
          id?: string
          metadata?: Json
          ntee_code?: string | null
          object_id?: string
          schema_version?: string | null
          source_url?: string
          subsection_code?: number | null
          tax_year?: number
          total_assets_eoy_cents?: number | null
          total_expenses_cents?: number | null
          total_revenue_cents?: number | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "irs990_filings_financial_entity_id_fkey"
            columns: ["financial_entity_id"]
            isOneToOne: false
            referencedRelation: "financial_entities"
            referencedColumns: ["id"]
          },
        ]
      }
      irs990_grants_out: {
        Row: {
          amount_cents: number
          filing_id: string
          id: string
          matched_entity_id: string | null
          matched_entity_type: string | null
          metadata: Json
          purpose: string | null
          recipient_ein: string | null
          recipient_name: string
          recipient_name_canonical: string
        }
        Insert: {
          amount_cents: number
          filing_id: string
          id?: string
          matched_entity_id?: string | null
          matched_entity_type?: string | null
          metadata?: Json
          purpose?: string | null
          recipient_ein?: string | null
          recipient_name: string
          recipient_name_canonical: string
        }
        Update: {
          amount_cents?: number
          filing_id?: string
          id?: string
          matched_entity_id?: string | null
          matched_entity_type?: string | null
          metadata?: Json
          purpose?: string | null
          recipient_ein?: string | null
          recipient_name?: string
          recipient_name_canonical?: string
        }
        Relationships: [
          {
            foreignKeyName: "irs990_grants_out_filing_id_fkey"
            columns: ["filing_id"]
            isOneToOne: false
            referencedRelation: "irs990_filings"
            referencedColumns: ["id"]
          },
        ]
      }
      irs990_officers: {
        Row: {
          compensation_cents: number | null
          filing_id: string
          hours_per_week: number | null
          id: string
          match_confidence: number | null
          matched_entity_id: string | null
          matched_entity_type: string | null
          metadata: Json
          name_canonical: string
          person_name: string
          role_title: string
        }
        Insert: {
          compensation_cents?: number | null
          filing_id: string
          hours_per_week?: number | null
          id?: string
          match_confidence?: number | null
          matched_entity_id?: string | null
          matched_entity_type?: string | null
          metadata?: Json
          name_canonical: string
          person_name: string
          role_title: string
        }
        Update: {
          compensation_cents?: number | null
          filing_id?: string
          hours_per_week?: number | null
          id?: string
          match_confidence?: number | null
          matched_entity_id?: string | null
          matched_entity_type?: string | null
          metadata?: Json
          name_canonical?: string
          person_name?: string
          role_title?: string
        }
        Relationships: [
          {
            foreignKeyName: "irs990_officers_filing_id_fkey"
            columns: ["filing_id"]
            isOneToOne: false
            referencedRelation: "irs990_filings"
            referencedColumns: ["id"]
          },
        ]
      }
      jurisdictions: {
        Row: {
          boundary_geometry: unknown
          census_geoid: string | null
          centroid: unknown
          country_code: string | null
          coverage_completed_at: string | null
          coverage_started_at: string | null
          coverage_status: string
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
          coverage_completed_at?: string | null
          coverage_started_at?: string | null
          coverage_status?: string
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
          coverage_completed_at?: string | null
          coverage_started_at?: string | null
          coverage_status?: string
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
      kill_switch_events: {
        Row: {
          flipped_at: string
          flipped_to: boolean
          id: number
          source: string
          switch_name: string
          threshold_pct: number | null
          trigger_metric: string | null
          trigger_value: number | null
        }
        Insert: {
          flipped_at?: string
          flipped_to: boolean
          id?: number
          source: string
          switch_name: string
          threshold_pct?: number | null
          trigger_metric?: string | null
          trigger_value?: number | null
        }
        Update: {
          flipped_at?: string
          flipped_to?: boolean
          id?: number
          source?: string
          switch_name?: string
          threshold_pct?: number | null
          trigger_metric?: string | null
          trigger_value?: number | null
        }
        Relationships: []
      }
      lobbying_disclosures: {
        Row: {
          amount_cents: number | null
          client_name: string
          created_at: string
          filing_period: string | null
          filing_year: number
          id: string
          industry_code: string | null
          metadata: Json
          official_id: string | null
          registrant_name: string
          source: string
          source_url: string | null
        }
        Insert: {
          amount_cents?: number | null
          client_name: string
          created_at?: string
          filing_period?: string | null
          filing_year: number
          id?: string
          industry_code?: string | null
          metadata?: Json
          official_id?: string | null
          registrant_name: string
          source?: string
          source_url?: string | null
        }
        Update: {
          amount_cents?: number | null
          client_name?: string
          created_at?: string
          filing_period?: string | null
          filing_year?: number
          id?: string
          industry_code?: string | null
          metadata?: Json
          official_id?: string | null
          registrant_name?: string
          source?: string
          source_url?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "lobbying_disclosures_industry_code_fkey"
            columns: ["industry_code"]
            isOneToOne: false
            referencedRelation: "industry_codes"
            referencedColumns: ["code"]
          },
          {
            foreignKeyName: "lobbying_disclosures_official_id_fkey"
            columns: ["official_id"]
            isOneToOne: false
            referencedRelation: "official_homepage_stats_mv"
            referencedColumns: ["official_id"]
          },
          {
            foreignKeyName: "lobbying_disclosures_official_id_fkey"
            columns: ["official_id"]
            isOneToOne: false
            referencedRelation: "officials"
            referencedColumns: ["id"]
          },
        ]
      }
      measure_details: {
        Row: {
          ballot_id: string
          ballotpedia_url: string | null
          election_date: string
          election_type: string | null
          measure_type: string | null
          no_votes: number | null
          originating_initiative_id: string | null
          passed: boolean | null
          percent_yes: number | null
          proposal_id: string
          text_summary: string | null
          yes_votes: number | null
        }
        Insert: {
          ballot_id: string
          ballotpedia_url?: string | null
          election_date: string
          election_type?: string | null
          measure_type?: string | null
          no_votes?: number | null
          originating_initiative_id?: string | null
          passed?: boolean | null
          percent_yes?: number | null
          proposal_id: string
          text_summary?: string | null
          yes_votes?: number | null
        }
        Update: {
          ballot_id?: string
          ballotpedia_url?: string | null
          election_date?: string
          election_type?: string | null
          measure_type?: string | null
          no_votes?: number | null
          originating_initiative_id?: string | null
          passed?: boolean | null
          percent_yes?: number | null
          proposal_id?: string
          text_summary?: string | null
          yes_votes?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "measure_details_originating_initiative_id_fkey"
            columns: ["originating_initiative_id"]
            isOneToOne: false
            referencedRelation: "proposal_trending_24h"
            referencedColumns: ["proposal_id"]
          },
          {
            foreignKeyName: "measure_details_originating_initiative_id_fkey"
            columns: ["originating_initiative_id"]
            isOneToOne: false
            referencedRelation: "proposals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "measure_details_proposal_id_fkey"
            columns: ["proposal_id"]
            isOneToOne: true
            referencedRelation: "proposal_trending_24h"
            referencedColumns: ["proposal_id"]
          },
          {
            foreignKeyName: "measure_details_proposal_id_fkey"
            columns: ["proposal_id"]
            isOneToOne: true
            referencedRelation: "proposals"
            referencedColumns: ["id"]
          },
        ]
      }
      meetings: {
        Row: {
          agenda_url: string | null
          created_at: string
          governing_body_id: string
          id: string
          location: string | null
          meeting_type: string
          metadata: Json
          minutes_url: string | null
          scheduled_at: string
          status: string
          title: string | null
          updated_at: string
          video_url: string | null
        }
        Insert: {
          agenda_url?: string | null
          created_at?: string
          governing_body_id: string
          id?: string
          location?: string | null
          meeting_type: string
          metadata?: Json
          minutes_url?: string | null
          scheduled_at: string
          status?: string
          title?: string | null
          updated_at?: string
          video_url?: string | null
        }
        Update: {
          agenda_url?: string | null
          created_at?: string
          governing_body_id?: string
          id?: string
          location?: string | null
          meeting_type?: string
          metadata?: Json
          minutes_url?: string | null
          scheduled_at?: string
          status?: string
          title?: string | null
          updated_at?: string
          video_url?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "meetings_governing_body_id_fkey"
            columns: ["governing_body_id"]
            isOneToOne: false
            referencedRelation: "governing_bodies"
            referencedColumns: ["id"]
          },
        ]
      }
      notifications: {
        Row: {
          body: string | null
          created_at: string
          email_sent: boolean
          entity_id: string | null
          entity_type: Database["public"]["Enums"]["follow_entity_type"] | null
          event_type: Database["public"]["Enums"]["notification_event_type"]
          id: string
          is_read: boolean
          link: string | null
          title: string
          user_id: string
        }
        Insert: {
          body?: string | null
          created_at?: string
          email_sent?: boolean
          entity_id?: string | null
          entity_type?: Database["public"]["Enums"]["follow_entity_type"] | null
          event_type: Database["public"]["Enums"]["notification_event_type"]
          id?: string
          is_read?: boolean
          link?: string | null
          title: string
          user_id: string
        }
        Update: {
          body?: string | null
          created_at?: string
          email_sent?: boolean
          entity_id?: string | null
          entity_type?: Database["public"]["Enums"]["follow_entity_type"] | null
          event_type?: Database["public"]["Enums"]["notification_event_type"]
          id?: string
          is_read?: boolean
          link?: string | null
          title?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "notifications_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
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
            referencedRelation: "proposal_trending_24h"
            referencedColumns: ["proposal_id"]
          },
          {
            foreignKeyName: "official_comment_submissions_proposal_id_fkey"
            columns: ["proposal_id"]
            isOneToOne: false
            referencedRelation: "proposals"
            referencedColumns: ["id"]
          },
        ]
      }
      official_committee_memberships: {
        Row: {
          committee_id: string
          created_at: string
          ended_at: string | null
          id: string
          metadata: Json
          official_id: string
          role: string
          started_at: string | null
          updated_at: string
        }
        Insert: {
          committee_id: string
          created_at?: string
          ended_at?: string | null
          id?: string
          metadata?: Json
          official_id: string
          role?: string
          started_at?: string | null
          updated_at?: string
        }
        Update: {
          committee_id?: string
          created_at?: string
          ended_at?: string | null
          id?: string
          metadata?: Json
          official_id?: string
          role?: string
          started_at?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "official_committee_memberships_committee_id_fkey"
            columns: ["committee_id"]
            isOneToOne: false
            referencedRelation: "governing_bodies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "official_committee_memberships_official_id_fkey"
            columns: ["official_id"]
            isOneToOne: false
            referencedRelation: "official_homepage_stats_mv"
            referencedColumns: ["official_id"]
          },
          {
            foreignKeyName: "official_committee_memberships_official_id_fkey"
            columns: ["official_id"]
            isOneToOne: false
            referencedRelation: "officials"
            referencedColumns: ["id"]
          },
        ]
      }
      official_community_comments: {
        Row: {
          body: string
          created_at: string
          id: string
          is_deleted: boolean
          metadata: Json
          official_id: string
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
          official_id: string
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
          official_id?: string
          updated_at?: string
          upvotes?: number
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "official_community_comments_official_id_fkey"
            columns: ["official_id"]
            isOneToOne: false
            referencedRelation: "official_homepage_stats_mv"
            referencedColumns: ["official_id"]
          },
          {
            foreignKeyName: "official_community_comments_official_id_fkey"
            columns: ["official_id"]
            isOneToOne: false
            referencedRelation: "officials"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "official_community_comments_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      officials: {
        Row: {
          created_at: string
          current_term_end: string | null
          current_term_start: string | null
          district_name: string | null
          email: string | null
          first_name: string | null
          full_name: string
          governing_body_id: string | null
          id: string
          is_active: boolean
          is_up_for_election: boolean
          is_verified: boolean
          jurisdiction_id: string
          last_name: string | null
          metadata: Json
          next_election_date: string | null
          next_election_type: string | null
          office_address: string | null
          party: Database["public"]["Enums"]["party"] | null
          phone: string | null
          photo_url: string | null
          primary_source: string | null
          primary_source_last_seen_at: string | null
          primary_source_url: string | null
          role_title: string
          source_ids: Json
          term_end: string | null
          term_start: string | null
          tier: string
          total_received_cents: number
          updated_at: string
          website_url: string | null
        }
        Insert: {
          created_at?: string
          current_term_end?: string | null
          current_term_start?: string | null
          district_name?: string | null
          email?: string | null
          first_name?: string | null
          full_name: string
          governing_body_id?: string | null
          id?: string
          is_active?: boolean
          is_up_for_election?: boolean
          is_verified?: boolean
          jurisdiction_id: string
          last_name?: string | null
          metadata?: Json
          next_election_date?: string | null
          next_election_type?: string | null
          office_address?: string | null
          party?: Database["public"]["Enums"]["party"] | null
          phone?: string | null
          photo_url?: string | null
          primary_source?: string | null
          primary_source_last_seen_at?: string | null
          primary_source_url?: string | null
          role_title: string
          source_ids?: Json
          term_end?: string | null
          term_start?: string | null
          tier?: string
          total_received_cents?: number
          updated_at?: string
          website_url?: string | null
        }
        Update: {
          created_at?: string
          current_term_end?: string | null
          current_term_start?: string | null
          district_name?: string | null
          email?: string | null
          first_name?: string | null
          full_name?: string
          governing_body_id?: string | null
          id?: string
          is_active?: boolean
          is_up_for_election?: boolean
          is_verified?: boolean
          jurisdiction_id?: string
          last_name?: string | null
          metadata?: Json
          next_election_date?: string | null
          next_election_type?: string | null
          office_address?: string | null
          party?: Database["public"]["Enums"]["party"] | null
          phone?: string | null
          photo_url?: string | null
          primary_source?: string | null
          primary_source_last_seen_at?: string | null
          primary_source_url?: string | null
          role_title?: string
          source_ids?: Json
          term_end?: string | null
          term_start?: string | null
          tier?: string
          total_received_cents?: number
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
      pipeline_cost_history: {
        Row: {
          actual_cost_usd: number | null
          actual_tokens_input: number | null
          actual_tokens_output: number | null
          entity_count: number
          estimated_cost_usd: number
          estimated_tokens_input: number | null
          estimated_tokens_output: number | null
          id: string
          metadata: Json | null
          notes: string | null
          paused_for_variance: boolean | null
          pipeline_name: string
          run_at: string | null
          sample_size: number | null
          status: string | null
          variance_ratio: number | null
          was_auto_approved: boolean | null
        }
        Insert: {
          actual_cost_usd?: number | null
          actual_tokens_input?: number | null
          actual_tokens_output?: number | null
          entity_count: number
          estimated_cost_usd: number
          estimated_tokens_input?: number | null
          estimated_tokens_output?: number | null
          id?: string
          metadata?: Json | null
          notes?: string | null
          paused_for_variance?: boolean | null
          pipeline_name: string
          run_at?: string | null
          sample_size?: number | null
          status?: string | null
          variance_ratio?: number | null
          was_auto_approved?: boolean | null
        }
        Update: {
          actual_cost_usd?: number | null
          actual_tokens_input?: number | null
          actual_tokens_output?: number | null
          entity_count?: number
          estimated_cost_usd?: number
          estimated_tokens_input?: number | null
          estimated_tokens_output?: number | null
          id?: string
          metadata?: Json | null
          notes?: string | null
          paused_for_variance?: boolean | null
          pipeline_name?: string
          run_at?: string | null
          sample_size?: number | null
          status?: string | null
          variance_ratio?: number | null
          was_auto_approved?: boolean | null
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
      platform_limits: {
        Row: {
          billing_cycle: string | null
          critical_pct: number | null
          display_group: string | null
          display_label: string | null
          display_limit: number | null
          has_public_api: boolean
          id: string
          included_limit: number
          is_active: boolean | null
          metric: string
          notes: string | null
          overage_cap: number | null
          overage_unit: string | null
          overage_unit_cost: number | null
          plan: string
          service: string
          sort_order: number | null
          unit: string
          updated_at: string | null
          warning_pct: number | null
        }
        Insert: {
          billing_cycle?: string | null
          critical_pct?: number | null
          display_group?: string | null
          display_label?: string | null
          display_limit?: number | null
          has_public_api?: boolean
          id?: string
          included_limit: number
          is_active?: boolean | null
          metric: string
          notes?: string | null
          overage_cap?: number | null
          overage_unit?: string | null
          overage_unit_cost?: number | null
          plan?: string
          service: string
          sort_order?: number | null
          unit: string
          updated_at?: string | null
          warning_pct?: number | null
        }
        Update: {
          billing_cycle?: string | null
          critical_pct?: number | null
          display_group?: string | null
          display_label?: string | null
          display_limit?: number | null
          has_public_api?: boolean
          id?: string
          included_limit?: number
          is_active?: boolean | null
          metric?: string
          notes?: string | null
          overage_cap?: number | null
          overage_unit?: string | null
          overage_unit_cost?: number | null
          plan?: string
          service?: string
          sort_order?: number | null
          unit?: string
          updated_at?: string | null
          warning_pct?: number | null
        }
        Relationships: []
      }
      platform_usage: {
        Row: {
          id: string
          metric: string
          period_end: string | null
          period_start: string | null
          recorded_at: string | null
          service: string
          source: string
          stale_after_days: number | null
          value: number
          verified_at: string | null
          verified_by: string | null
        }
        Insert: {
          id?: string
          metric: string
          period_end?: string | null
          period_start?: string | null
          recorded_at?: string | null
          service: string
          source?: string
          stale_after_days?: number | null
          value: number
          verified_at?: string | null
          verified_by?: string | null
        }
        Update: {
          id?: string
          metric?: string
          period_end?: string | null
          period_start?: string | null
          recorded_at?: string | null
          service?: string
          source?: string
          stale_after_days?: number | null
          value?: number
          verified_at?: string | null
          verified_by?: string | null
        }
        Relationships: []
      }
      platform_usage_snapshot: {
        Row: {
          any_critical: boolean
          any_warning: boolean
          error: string | null
          fetched_at: string
          id: number
          payload: Json
          total_overage_cost: number
        }
        Insert: {
          any_critical?: boolean
          any_warning?: boolean
          error?: string | null
          fetched_at?: string
          id?: number
          payload: Json
          total_overage_cost?: number
        }
        Update: {
          any_critical?: boolean
          any_warning?: boolean
          error?: string | null
          fetched_at?: string
          id?: number
          payload?: Json
          total_overage_cost?: number
        }
        Relationships: []
      }
      position_events: {
        Row: {
          attributed_comment_id: string | null
          created_at: string
          entity_id: string
          entity_type: string
          from_stance: number | null
          id: string
          note: string | null
          to_stance: number
          user_id: string
        }
        Insert: {
          attributed_comment_id?: string | null
          created_at?: string
          entity_id: string
          entity_type: string
          from_stance?: number | null
          id?: string
          note?: string | null
          to_stance: number
          user_id: string
        }
        Update: {
          attributed_comment_id?: string | null
          created_at?: string
          entity_id?: string
          entity_type?: string
          from_stance?: number | null
          id?: string
          note?: string | null
          to_stance?: number
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "position_events_attributed_comment_id_fkey"
            columns: ["attributed_comment_id"]
            isOneToOne: false
            referencedRelation: "entity_comments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "position_events_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
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
            referencedRelation: "official_homepage_stats_mv"
            referencedColumns: ["official_id"]
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
            referencedRelation: "proposal_trending_24h"
            referencedColumns: ["proposal_id"]
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
      proposal_actions: {
        Row: {
          action_at: string
          action_type: string
          created_at: string
          description: string | null
          id: string
          metadata: Json
          performed_by_id: string | null
          proposal_id: string
          source: string | null
        }
        Insert: {
          action_at: string
          action_type: string
          created_at?: string
          description?: string | null
          id?: string
          metadata?: Json
          performed_by_id?: string | null
          proposal_id: string
          source?: string | null
        }
        Update: {
          action_at?: string
          action_type?: string
          created_at?: string
          description?: string | null
          id?: string
          metadata?: Json
          performed_by_id?: string | null
          proposal_id?: string
          source?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "proposal_actions_performed_by_id_fkey"
            columns: ["performed_by_id"]
            isOneToOne: false
            referencedRelation: "official_homepage_stats_mv"
            referencedColumns: ["official_id"]
          },
          {
            foreignKeyName: "proposal_actions_performed_by_id_fkey"
            columns: ["performed_by_id"]
            isOneToOne: false
            referencedRelation: "officials"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "proposal_actions_proposal_id_fkey"
            columns: ["proposal_id"]
            isOneToOne: false
            referencedRelation: "proposal_trending_24h"
            referencedColumns: ["proposal_id"]
          },
          {
            foreignKeyName: "proposal_actions_proposal_id_fkey"
            columns: ["proposal_id"]
            isOneToOne: false
            referencedRelation: "proposals"
            referencedColumns: ["id"]
          },
        ]
      }
      proposal_cosponsors: {
        Row: {
          created_at: string
          date_added: string | null
          date_withdrawn: string | null
          id: string
          is_original_cosponsor: boolean
          official_id: string
          proposal_id: string
          source: string
        }
        Insert: {
          created_at?: string
          date_added?: string | null
          date_withdrawn?: string | null
          id?: string
          is_original_cosponsor?: boolean
          official_id: string
          proposal_id: string
          source?: string
        }
        Update: {
          created_at?: string
          date_added?: string | null
          date_withdrawn?: string | null
          id?: string
          is_original_cosponsor?: boolean
          official_id?: string
          proposal_id?: string
          source?: string
        }
        Relationships: [
          {
            foreignKeyName: "proposal_cosponsors_official_id_fkey"
            columns: ["official_id"]
            isOneToOne: false
            referencedRelation: "official_homepage_stats_mv"
            referencedColumns: ["official_id"]
          },
          {
            foreignKeyName: "proposal_cosponsors_official_id_fkey"
            columns: ["official_id"]
            isOneToOne: false
            referencedRelation: "officials"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "proposal_cosponsors_proposal_id_fkey"
            columns: ["proposal_id"]
            isOneToOne: false
            referencedRelation: "proposal_trending_24h"
            referencedColumns: ["proposal_id"]
          },
          {
            foreignKeyName: "proposal_cosponsors_proposal_id_fkey"
            columns: ["proposal_id"]
            isOneToOne: false
            referencedRelation: "proposals"
            referencedColumns: ["id"]
          },
        ]
      }
      proposals: {
        Row: {
          created_at: string
          external_url: string | null
          full_text_r2_key: string | null
          full_text_url: string | null
          governing_body_id: string | null
          id: string
          introduced_at: string | null
          jurisdiction_id: string
          last_action_at: string | null
          metadata: Json
          primary_source: string | null
          primary_source_last_seen_at: string | null
          primary_source_url: string | null
          resolved_at: string | null
          search_vector: unknown
          short_title: string | null
          status: Database["public"]["Enums"]["proposal_status"]
          summary_generated_at: string | null
          summary_model: string | null
          summary_plain: string | null
          title: string
          type: Database["public"]["Enums"]["proposal_type"]
          updated_at: string
          vote_category: string | null
        }
        Insert: {
          created_at?: string
          external_url?: string | null
          full_text_r2_key?: string | null
          full_text_url?: string | null
          governing_body_id?: string | null
          id?: string
          introduced_at?: string | null
          jurisdiction_id: string
          last_action_at?: string | null
          metadata?: Json
          primary_source?: string | null
          primary_source_last_seen_at?: string | null
          primary_source_url?: string | null
          resolved_at?: string | null
          search_vector?: unknown
          short_title?: string | null
          status?: Database["public"]["Enums"]["proposal_status"]
          summary_generated_at?: string | null
          summary_model?: string | null
          summary_plain?: string | null
          title: string
          type: Database["public"]["Enums"]["proposal_type"]
          updated_at?: string
          vote_category?: string | null
        }
        Update: {
          created_at?: string
          external_url?: string | null
          full_text_r2_key?: string | null
          full_text_url?: string | null
          governing_body_id?: string | null
          id?: string
          introduced_at?: string | null
          jurisdiction_id?: string
          last_action_at?: string | null
          metadata?: Json
          primary_source?: string | null
          primary_source_last_seen_at?: string | null
          primary_source_url?: string | null
          resolved_at?: string | null
          search_vector?: unknown
          short_title?: string | null
          status?: Database["public"]["Enums"]["proposal_status"]
          summary_generated_at?: string | null
          summary_model?: string | null
          summary_plain?: string | null
          title?: string
          type?: Database["public"]["Enums"]["proposal_type"]
          updated_at?: string
          vote_category?: string | null
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
      statement_votes: {
        Row: {
          created_at: string
          statement_id: string
          updated_at: string
          vote: number
          voter_id: string
        }
        Insert: {
          created_at?: string
          statement_id: string
          updated_at?: string
          vote: number
          voter_id: string
        }
        Update: {
          created_at?: string
          statement_id?: string
          updated_at?: string
          vote?: number
          voter_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "statement_votes_statement_id_fkey"
            columns: ["statement_id"]
            isOneToOne: false
            referencedRelation: "entity_statements"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "statement_votes_voter_id_fkey"
            columns: ["voter_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      status_snapshot: {
        Row: {
          error: string | null
          fetched_at: string
          id: number
          payload: Json
          query_time_ms: number
          section_times: Json | null
        }
        Insert: {
          error?: string | null
          fetched_at?: string
          id?: number
          payload: Json
          query_time_ms: number
          section_times?: Json | null
        }
        Update: {
          error?: string | null
          fetched_at?: string
          id?: number
          payload?: Json
          query_time_ms?: number
          section_times?: Json | null
        }
        Relationships: []
      }
      supabase_prometheus_state: {
        Row: {
          baseline_at: string
          baseline_value: number
          last_raw_value: number
          last_scraped_at: string
          metric: string
        }
        Insert: {
          baseline_at?: string
          baseline_value: number
          last_raw_value: number
          last_scraped_at?: string
          metric: string
        }
        Update: {
          baseline_at?: string
          baseline_value?: number
          last_raw_value?: number
          last_scraped_at?: string
          metric?: string
        }
        Relationships: []
      }
      user_custom_groups: {
        Row: {
          color: string | null
          created_at: string
          filter: Json
          icon: string | null
          id: string
          is_public: boolean
          name: string
          updated_at: string
          user_id: string
        }
        Insert: {
          color?: string | null
          created_at?: string
          filter: Json
          icon?: string | null
          id?: string
          is_public?: boolean
          name: string
          updated_at?: string
          user_id: string
        }
        Update: {
          color?: string | null
          created_at?: string
          filter?: Json
          icon?: string | null
          id?: string
          is_public?: boolean
          name?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_custom_groups_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      user_follows: {
        Row: {
          created_at: string
          email_enabled: boolean
          entity_id: string
          entity_type: Database["public"]["Enums"]["follow_entity_type"]
          id: string
          user_id: string
        }
        Insert: {
          created_at?: string
          email_enabled?: boolean
          entity_id: string
          entity_type: Database["public"]["Enums"]["follow_entity_type"]
          id?: string
          user_id: string
        }
        Update: {
          created_at?: string
          email_enabled?: boolean
          entity_id?: string
          entity_type?: Database["public"]["Enums"]["follow_entity_type"]
          id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_follows_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      user_preferences: {
        Row: {
          created_at: string
          followed_agencies: string[]
          followed_officials: string[]
          followed_proposals: string[]
          graph_root_hint: string | null
          home_district: number | null
          home_jurisdiction_id: string | null
          home_state: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          followed_agencies?: string[]
          followed_officials?: string[]
          followed_proposals?: string[]
          graph_root_hint?: string | null
          home_district?: number | null
          home_jurisdiction_id?: string | null
          home_state?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          followed_agencies?: string[]
          followed_officials?: string[]
          followed_proposals?: string[]
          graph_root_hint?: string | null
          home_district?: number | null
          home_jurisdiction_id?: string | null
          home_state?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_preferences_home_jurisdiction_id_fkey"
            columns: ["home_jurisdiction_id"]
            isOneToOne: false
            referencedRelation: "jurisdictions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_preferences_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: true
            referencedRelation: "users"
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
          agenda_item_id: string | null
          bill_proposal_id: string
          chamber: string
          created_at: string
          id: string
          metadata: Json
          official_id: string
          primary_source: string | null
          primary_source_last_seen_at: string | null
          primary_source_url: string | null
          roll_call_id: string
          session: string | null
          source_url: string | null
          updated_at: string
          vote: string
          vote_question: string | null
          voted_at: string
        }
        Insert: {
          agenda_item_id?: string | null
          bill_proposal_id: string
          chamber: string
          created_at?: string
          id?: string
          metadata?: Json
          official_id: string
          primary_source?: string | null
          primary_source_last_seen_at?: string | null
          primary_source_url?: string | null
          roll_call_id: string
          session?: string | null
          source_url?: string | null
          updated_at?: string
          vote: string
          vote_question?: string | null
          voted_at: string
        }
        Update: {
          agenda_item_id?: string | null
          bill_proposal_id?: string
          chamber?: string
          created_at?: string
          id?: string
          metadata?: Json
          official_id?: string
          primary_source?: string | null
          primary_source_last_seen_at?: string | null
          primary_source_url?: string | null
          roll_call_id?: string
          session?: string | null
          source_url?: string | null
          updated_at?: string
          vote?: string
          vote_question?: string | null
          voted_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "votes_agenda_item_id_fkey"
            columns: ["agenda_item_id"]
            isOneToOne: false
            referencedRelation: "agenda_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "votes_bill_proposal_id_fkey"
            columns: ["bill_proposal_id"]
            isOneToOne: false
            referencedRelation: "bill_details"
            referencedColumns: ["proposal_id"]
          },
          {
            foreignKeyName: "votes_official_id_fkey"
            columns: ["official_id"]
            isOneToOne: false
            referencedRelation: "official_homepage_stats_mv"
            referencedColumns: ["official_id"]
          },
          {
            foreignKeyName: "votes_official_id_fkey"
            columns: ["official_id"]
            isOneToOne: false
            referencedRelation: "officials"
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
      web_vitals_samples: {
        Row: {
          exceeded: boolean
          id: string
          metric: string
          path: string | null
          rating: string | null
          recorded_at: string
          user_agent: string | null
          value: number
        }
        Insert: {
          exceeded?: boolean
          id?: string
          metric: string
          path?: string | null
          rating?: string | null
          recorded_at?: string
          user_agent?: string | null
          value: number
        }
        Update: {
          exceeded?: boolean
          id?: string
          metric?: string
          path?: string | null
          rating?: string | null
          recorded_at?: string
          user_agent?: string | null
          value?: number
        }
        Relationships: []
      }
    }
    Views: {
      chord_donor_state_party_flows_mv: {
        Row: {
          donor_state: string | null
          party_chamber: string | null
          total_usd: number | null
        }
        Relationships: []
      }
      chord_donor_type_party_flows_mv: {
        Row: {
          donor_type: string | null
          party_chamber: string | null
          total_usd: number | null
        }
        Relationships: []
      }
      chord_industry_flows_mv: {
        Row: {
          display_icon: string | null
          display_label: string | null
          donor_count: number | null
          industry: string | null
          official_count: number | null
          party_chamber: string | null
          total_cents: number | null
        }
        Relationships: []
      }
      chord_subject_party_flows_mv: {
        Row: {
          display_icon: string | null
          display_label: string | null
          party_chamber: string | null
          subject: string | null
          vote_count: number | null
        }
        Relationships: []
      }
      donor_party_rollup_mv: {
        Row: {
          donor_id: string | null
          donor_name: string | null
          entity_type: string | null
          industry_label: string | null
          industry_tag: string | null
          party_key: string | null
          total_cents: number | null
          tx_count: number | null
        }
        Relationships: []
      }
      entity_connection_stats_mv: {
        Row: {
          connection_count: number | null
          entity_id: string | null
          has_donation: boolean | null
          has_vote: boolean | null
          vote_count: number | null
        }
        Relationships: []
      }
      homepage_agency_counts_mv: {
        Row: {
          agency_id: string | null
          open: number | null
          refreshed_at: string | null
          total: number | null
        }
        Relationships: []
      }
      homepage_stats_mv: {
        Row: {
          active_proposals_count: number | null
          donor_records_count: number | null
          officials_count: number | null
          refreshed_at: string | null
          spending_records_count: number | null
        }
        Relationships: []
      }
      institutions: {
        Row: {
          acronym: string | null
          contact_email: string | null
          created_at: string | null
          id: string | null
          is_active: boolean | null
          jurisdiction_id: string | null
          metadata: Json | null
          name: string | null
          parent_id: string | null
          primary_source: string | null
          primary_source_last_seen_at: string | null
          primary_source_url: string | null
          short_name: string | null
          slug: string | null
          source_table: string | null
          type: string | null
          updated_at: string | null
          usaspending_agency_id: string | null
          usaspending_subtier_id: string | null
          website_url: string | null
        }
        Relationships: []
      }
      official_donor_rollup_mv: {
        Row: {
          donor_id: string | null
          donor_name: string | null
          entity_type: string | null
          industry_label: string | null
          industry_tag: string | null
          official_id: string | null
          rank: number | null
          relationship_type: string | null
          tail_donor_count: number | null
          total_cents: number | null
          tx_count: number | null
        }
        Relationships: []
      }
      official_homepage_stats_mv: {
        Row: {
          donor_count: number | null
          financial_relationship_count: number | null
          official_id: string | null
          refreshed_at: string | null
          total_donations_cents: number | null
          vote_count: number | null
        }
        Relationships: []
      }
      official_sector_dollars_mv: {
        Row: {
          display_icon: string | null
          donor_count: number | null
          official_id: string | null
          sector_label: string | null
          sector_tag: string | null
          total_cents: number | null
        }
        Relationships: []
      }
      pipeline_runtime_stats_mv: {
        Row: {
          last_run_at: string | null
          max_duration_ms: number | null
          max_peak_rss_mb: number | null
          p50_duration_ms: number | null
          p95_duration_ms: number | null
          p95_peak_rss_mb: number | null
          pipeline: string | null
          runs_30d: number | null
          success_rate_pct: number | null
          successful_runs_30d: number | null
        }
        Relationships: []
      }
      proposal_comment_stats: {
        Row: {
          comment_count: number | null
          comments_24h: number | null
          comments_7d: number | null
          distinct_commenters: number | null
          last_commented_at: string | null
          proposal_id: string | null
        }
        Relationships: []
      }
      proposal_popularity_24h: {
        Row: {
          last_viewed_at: string | null
          proposal_id: string | null
          view_count: number | null
        }
        Relationships: []
      }
      proposal_trending_24h: {
        Row: {
          comments_24h: number | null
          last_activity_at: string | null
          proposal_id: string | null
          status: Database["public"]["Enums"]["proposal_status"] | null
          title: string | null
          total_comments: number | null
          trending_score: number | null
          type: Database["public"]["Enums"]["proposal_type"] | null
        }
        Relationships: []
      }
    }
    Functions: {
      backfill_governing_body_slugs: { Args: never; Returns: number }
      backfill_jurisdiction_boundary: {
        Args: { p_geojson: string; p_id: string }
        Returns: boolean
      }
      canonical_donor_fingerprint: {
        Args: { raw_name: string; zip5: string }
        Returns: string
      }
      chord_contract_flows: {
        Args: never
        Returns: {
          agency_acronym: string
          agency_id: string
          agency_name: string
          award_count: number
          sector: string
          total_cents: number
        }[]
      }
      chord_donor_brackets_for_official: {
        Args: { p_official_id: string }
        Returns: {
          bracket: string
          donor_count: number
          total_cents: number
        }[]
      }
      chord_donor_state_party_flows: {
        Args: { p_official_id?: string }
        Returns: {
          donor_state: string
          party_chamber: string
          total_usd: number
        }[]
      }
      chord_donor_type_party_flows: {
        Args: { p_official_ids?: string[] }
        Returns: {
          donor_type: string
          party_chamber: string
          total_usd: number
        }[]
      }
      chord_industry_flows: {
        Args: never
        Returns: {
          display_icon: string
          display_label: string
          donor_count: number
          industry: string
          official_count: number
          party_chamber: string
          total_cents: number
        }[]
      }
      chord_industry_flows_for_official: {
        Args: { p_official_id: string }
        Returns: {
          display_icon: string
          display_label: string
          donor_count: number
          industry: string
          total_cents: number
        }[]
      }
      chord_sector_vote_for_officials: {
        Args: { p_min_usd?: number; p_official_ids: string[] }
        Returns: {
          display_icon: string
          display_label: string
          sector: string
          total_usd: number
          vote_count: number
          vote_outcome: string
        }[]
      }
      chord_subject_party_flows: {
        Args: { p_official_ids?: string[] }
        Returns: {
          display_icon: string
          display_label: string
          party_chamber: string
          subject: string
          vote_count: number
        }[]
      }
      chord_top_pacs_for_official: {
        Args: { p_limit?: number; p_official_id: string }
        Returns: {
          display_icon: string
          display_label: string
          industry: string
          pac_id: string
          pac_name: string
          total_cents: number
        }[]
      }
      civitics_slugify: { Args: { input: string }; Returns: string }
      claim_enrichment_batch: {
        Args: { p_claimed_by: string; p_limit: number; p_task_type: string }
        Returns: {
          claimed_at: string | null
          claimed_by: string | null
          completed_at: string | null
          context: Json | null
          created_at: string
          entity_id: string
          entity_type: string
          entity_updated_at: string
          id: number
          last_error: string | null
          priority: number
          result: Json | null
          retry_count: number
          status: string
          task_type: string
        }[]
        SetofOptions: {
          from: "*"
          to: "enrichment_queue"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      clear_financial_entity_rule_tags: {
        Args: { p_categories: string[] }
        Returns: number
      }
      compute_alignment_score: {
        Args: { p_official_id: string; p_user_id: string }
        Returns: {
          alignment_ratio: number
          matched_votes: number
          total_votes: number
          vote_details: Json
        }[]
      }
      enqueue_enrichment: {
        Args: {
          p_context: Json
          p_entity_id: string
          p_entity_type: string
          p_entity_updated_at?: string
          p_priority?: number
          p_task_type: string
        }
        Returns: string
      }
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
      get_connection_counts: {
        Args: { entity_ids: string[] }
        Returns: {
          connection_count: number
          entity_id: string
        }[]
      }
      get_connection_type_counts: {
        Args: never
        Returns: {
          connection_type: string
          total: number
        }[]
      }
      get_crossgroup_sector_totals: {
        Args: { p_group1_ids: string[]; p_group2_ids: string[] }
        Returns: {
          group1_usd: number
          group2_usd: number
          sector: string
        }[]
      }
      get_current_usage: {
        Args: { p_metric: string; p_service: string }
        Returns: {
          recorded_at: string
          source: string
          stale_after_days: number
          value: number
          verified_at: string
        }[]
      }
      get_database_size_bytes: { Args: never; Returns: number }
      get_drift_source_presence: {
        Args: never
        Returns: {
          has_rows: boolean
          rule_type: string
        }[]
      }
      get_entity_comment_highlights: {
        Args: { p_entity_id: string; p_entity_type: string; p_lens?: string }
        Returns: Json
      }
      get_entity_position_rollup: {
        Args: { p_entity_id: string; p_entity_type: string; p_lens?: string }
        Returns: {
          buckets: Json
          median: number
          n: number
          pct_with_conditions: number
        }[]
      }
      get_entity_questions: {
        Args: { p_official_id: string; p_lens?: string; p_sort?: string }
        Returns: Json
      }
      get_entity_statements: {
        Args: { p_entity_id: string; p_entity_type: string; p_lens?: string }
        Returns: Json
      }
      get_financial_entity_naics: { Args: never; Returns: Json }
      get_group_connections: {
        Args: { p_limit?: number; p_member_ids: string[] }
        Returns: {
          amount_cents: number
          connection_type: string
          from_id: string
          strength: number
          to_id: string
        }[]
      }
      get_group_donor_totals: {
        Args: { p_official_ids: string[] }
        Returns: {
          entity_name: string
          entity_type: string
          financial_entity_id: string
          member_count: number
          total_cents: number
        }[]
      }
      get_group_sector_totals: {
        Args: { p_member_ids: string[]; p_min_usd?: number }
        Returns: {
          sector: string
          total_usd: number
        }[]
      }
      get_institution_recent_votes: {
        Args: { p_institution_id: string; p_limit?: number }
        Returns: {
          abstain_count: number
          bill_number: string
          no_count: number
          not_voting_count: number
          party_line: boolean
          proposal_id: string
          proposal_title: string
          unanimous: boolean
          vote_question: string
          voted_at: string
          yes_count: number
        }[]
      }
      get_jurisdiction_activity: {
        Args: { p_id: string; p_limit?: number }
        Returns: {
          entity_id: string
          event_type: string
          occurred_at: string
          summary: string
          url: string
        }[]
      }
      get_official_bipartisan_stats: { Args: never; Returns: Json }
      get_official_donor_rollup: { Args: never; Returns: Json }
      get_official_donors: {
        Args: { p_official_id: string }
        Returns: {
          entity_name: string
          entity_type: string
          financial_entity_id: string
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
      get_officials_by_filter: {
        Args: { p_chamber?: string; p_party?: string; p_state?: string }
        Returns: {
          id: string
        }[]
      }
      get_pac_donations_by_party: {
        Args: never
        Returns: {
          donation_count: number
          donor_name: string
          party: string
          total_usd: number
        }[]
      }
      get_pac_treemap_by_party: {
        Args: { p_min_cents?: number }
        Returns: Json
      }
      get_pac_treemap_by_sector: {
        Args: { p_industry?: string; p_min_cents?: number }
        Returns: Json
      }
      get_proposal_counts_by_agency: {
        Args: never
        Returns: {
          agency_id: string
          open: number
          total: number
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
      get_pv_entry_pages: {
        Args: { days?: number; lim?: number }
        Returns: {
          page: string
          sessions: number
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
      get_pv_top_transitions: {
        Args: { days?: number; lim?: number; min_count?: number }
        Returns: {
          from_page: string
          sessions: number
          to_page: string
        }[]
      }
      get_quality_counts: {
        Args: never
        Returns: {
          tagged_pacs: number
          total_pacs: number
          vote_category_counts: Json
          vote_connection_total: number
        }[]
      }
      get_supabase_auth_mau: { Args: never; Returns: number }
      get_supabase_cpu_max: {
        Args: { window_minutes: number }
        Returns: number
      }
      get_supabase_max_connections: { Args: never; Returns: number }
      get_supabase_self_metrics: {
        Args: never
        Returns: {
          db_size_bytes: number
          storage_bytes: number
        }[]
      }
      get_top_connected_officials: {
        Args: { p_limit?: number }
        Returns: {
          connection_count: number
          entity_id: string
        }[]
      }
      get_topic_proposal_page: {
        Args: {
          p_agency: string
          p_limit: number
          p_offset: number
          p_q: string
          p_sort: string
          p_status: string
          p_tags: string[]
          p_type: string
        }
        Returns: {
          id: string
          introduced_at: string
          metadata: Json
          status: string
          summary_model: string
          summary_plain: string
          title: string
          total_count: number
          type: string
        }[]
      }
      get_vote_agreement_matrix: {
        Args: { p_official_ids: string[] }
        Returns: {
          agreed: number
          official_a: string
          official_b: string
          shared: number
          yes_a: number
          yes_b: number
        }[]
      }
      has_active_constituent_grant: {
        Args: { p_jurisdiction_id: string; p_user_id: string }
        Returns: boolean
      }
      has_active_official_grant: {
        Args: { p_official_id: string; p_user_id: string }
        Returns: boolean
      }
      jurisdiction_boundary_svg: {
        Args: { p_height?: number; p_id: string; p_width?: number }
        Returns: {
          centroid_x: number
          centroid_y: number
          svg_path: string
          viewbox: string
        }[]
      }
      jurisdictions_containing_point: {
        Args: { p_lat: number; p_lng: number }
        Returns: {
          id: string
          name: string
          type: string
        }[]
      }
      link_federal_reps_to_districts: { Args: never; Returns: number }
      link_officials_to_districts: { Args: never; Returns: number }
      normalize_pv_path: { Args: { p: string }; Returns: string }
      promote_candidate_to_elected: {
        Args: { p_candidate_id: string; p_elected_id: string }
        Returns: Json
      }
      prune_kill_switch_events: { Args: never; Returns: number }
      prune_platform_usage_snapshot: { Args: never; Returns: number }
      prune_status_snapshot: { Args: never; Returns: number }
      query_districts: {
        Args: {
          p_bbox_e?: number
          p_bbox_n?: number
          p_bbox_s?: number
          p_bbox_w?: number
          p_chamber?: string
          p_id?: string
          p_limit?: number
          p_point_lat?: number
          p_point_lng?: number
          p_simplify_tolerance?: number
          p_state?: string
        }
        Returns: {
          chamber: string
          district_id: string
          geom_geojson: string
          id: string
          name: string
          short_name: string
          state_abbr: string
        }[]
      }
      reap_stale_sync_log: {
        Args: { stale_minutes?: number }
        Returns: {
          id: string
          pipeline: string
          reaped_at: string
        }[]
      }
      rebuild_all_primary_sources: {
        Args: never
        Returns: {
          rows_updated: number
          table_name: string
        }[]
      }
      rebuild_entity_connections: {
        Args: never
        Returns: {
          connection_type: string
          edges_upserted: number
        }[]
      }
      rebuild_entity_connections_appointments: {
        Args: never
        Returns: {
          connection_type: string
          edges_upserted: number
        }[]
      }
      rebuild_entity_connections_contracts: {
        Args: never
        Returns: {
          connection_type: string
          edges_upserted: number
        }[]
      }
      rebuild_entity_connections_cosponsors: {
        Args: never
        Returns: {
          connection_type: string
          edges_upserted: number
        }[]
      }
      rebuild_entity_connections_donations: {
        Args: never
        Returns: {
          connection_type: string
          edges_upserted: number
        }[]
      }
      rebuild_entity_connections_donations_full: {
        Args: never
        Returns: {
          connection_type: string
          edges_upserted: number
        }[]
      }
      rebuild_entity_connections_external: {
        Args: never
        Returns: {
          connection_type: string
          edges_upserted: number
        }[]
      }
      rebuild_entity_connections_gifts: {
        Args: never
        Returns: {
          connection_type: string
          edges_upserted: number
        }[]
      }
      rebuild_entity_connections_holds: {
        Args: never
        Returns: {
          connection_type: string
          edges_upserted: number
        }[]
      }
      rebuild_entity_connections_lobbying: {
        Args: never
        Returns: {
          connection_type: string
          edges_upserted: number
        }[]
      }
      rebuild_entity_connections_oversight: {
        Args: never
        Returns: {
          connection_type: string
          edges_upserted: number
        }[]
      }
      rebuild_entity_connections_votes: {
        Args: never
        Returns: {
          connection_type: string
          edges_upserted: number
        }[]
      }
      rebuild_entity_connections_votes_full: {
        Args: never
        Returns: {
          connection_type: string
          edges_upserted: number
        }[]
      }
      rebuild_financial_entity_donation_totals: {
        Args: never
        Returns: undefined
      }
      rebuild_financial_entity_donation_totals_full: {
        Args: never
        Returns: undefined
      }
      rebuild_financial_entity_size_tags: { Args: never; Returns: number }
      rebuild_official_donation_totals: { Args: never; Returns: undefined }
      rebuild_official_donation_totals_full: { Args: never; Returns: undefined }
      rebuild_pre_vote_timing_tags: { Args: never; Returns: number }
      recompute_comment_bridge_scores: {
        Args: { p_entity_id?: string; p_entity_type?: string }
        Returns: number
      }
      record_enrichment_failure: {
        Args: { p_error: string; p_queue_id: number }
        Returns: string
      }
      refresh_chord_donor_state_party_flows_mv: {
        Args: never
        Returns: undefined
      }
      refresh_chord_donor_type_party_flows_mv: {
        Args: never
        Returns: undefined
      }
      refresh_chord_industry_flows_mv: { Args: never; Returns: undefined }
      refresh_chord_subject_party_flows_mv: { Args: never; Returns: undefined }
      refresh_connection_type_counts: { Args: never; Returns: undefined }
      refresh_donor_party_rollup_mv: { Args: never; Returns: undefined }
      refresh_entity_connection_stats_mv: { Args: never; Returns: undefined }
      refresh_group_donor_rollup: { Args: never; Returns: Json }
      refresh_homepage_agency_counts_mv: { Args: never; Returns: undefined }
      refresh_homepage_stats_mv: { Args: never; Returns: undefined }
      refresh_official_donor_rollup_mv: { Args: never; Returns: undefined }
      refresh_official_homepage_stats_mv: { Args: never; Returns: undefined }
      refresh_official_sector_dollars_mv: { Args: never; Returns: undefined }
      refresh_pipeline_runtime_stats_mv: { Args: never; Returns: undefined }
      refresh_primary_source_for_entities: {
        Args: { p_entity_ids: string[]; p_entity_type: string }
        Returns: number
      }
      refresh_proposal_popularity: { Args: never; Returns: undefined }
      refresh_proposal_trending: { Args: never; Returns: undefined }
      refresh_spending_totals: { Args: never; Returns: undefined }
      resolve_entity_by_canonical: {
        Args: {
          p_canonical_name: string
          p_entity_type?: string
          p_state?: string
        }
        Returns: string
      }
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
      set_entity_position: {
        Args: {
          p_attributed_comment_id?: string
          p_conditions_md?: string
          p_entity_id: string
          p_entity_type: string
          p_note?: string
          p_stance: number
        }
        Returns: {
          conditions_md: string | null
          constituent_jurisdiction_id: string | null
          created_at: string
          entity_id: string
          entity_type: string
          stance: number
          updated_at: string
          user_id: string
        }
        SetofOptions: {
          from: "*"
          to: "entity_positions"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      set_statement_vote: {
        Args: { p_statement_id: string; p_vote: number }
        Returns: Json
      }
      source_priority: { Args: { src: string }; Returns: number }
      submit_comment: {
        Args: {
          p_body: string
          p_conditions_md?: string
          p_entity_id: string
          p_entity_type: string
          p_kind?: string
          p_parent_id?: string
          p_stance?: string
        }
        Returns: {
          author_id: string
          body: string
          bridge_score: number | null
          conditions_md: string | null
          constituent_jurisdiction_id: string | null
          created_at: string
          entity_id: string
          entity_type: string
          id: string
          kind: string
          map_x: number | null
          map_y: number | null
          metadata: Json
          parent_id: string | null
          rating_summary: Json
          stance: string | null
          status: string
          thread_root_id: string | null
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "entity_comments"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      submit_statement: {
        Args: {
          p_body: string
          p_entity_id: string
          p_entity_type: string
          p_source_comment_id?: string
        }
        Returns: {
          author_id: string | null
          body: string
          constituent_jurisdiction_id: string | null
          created_at: string
          entity_id: string
          entity_type: string
          id: string
          metadata: Json
          source_comment_id: string | null
          status: string
          updated_at: string
          vote_summary: Json
        }
        SetofOptions: {
          from: "*"
          to: "entity_statements"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      treemap_officials_by_donations:
        | {
            Args: { lim?: number }
            Returns: {
              chamber: string
              official_id: string
              official_name: string
              party: string
              state: string
              total_donated_cents: number
            }[]
          }
        | {
            Args: {
              lim?: number
              p_chamber?: string
              p_party?: string
              p_state?: string
            }
            Returns: {
              chamber: string
              official_id: string
              official_name: string
              party: string
              state: string
              total_donated_cents: number
            }[]
          }
      treemap_recipients_by_contracts: {
        Args: { lim?: number }
        Returns: {
          award_count: number
          entity_id: string
          entity_name: string
          industry: string
          naics_code: string
          total_cents: number
        }[]
      }
      upsert_county_jurisdiction: {
        Args: {
          p_boundary_geojson: string
          p_census_geoid: string
          p_fips_code: string
          p_name: string
          p_parent_id: string
          p_short_name: string
        }
        Returns: string
      }
      upsert_district_jurisdiction: {
        Args: {
          p_census_geoid: string
          p_chamber: string
          p_fips_code: string
          p_geojson: string
          p_metadata: Json
          p_name: string
          p_parent_id: string
          p_short_name: string
        }
        Returns: string
      }
    }
    Enums: {
      argument_flag: "off_topic" | "misleading" | "duplicate" | "other"
      argument_side: "for" | "against"
      connection_type:
        | "donation"
        | "vote_yes"
        | "vote_no"
        | "vote_abstain"
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
        | "nomination_vote_yes"
        | "nomination_vote_no"
        | "holds_position"
        | "gift_received"
        | "member_of"
        | "owns"
        | "parent_of"
        | "affiliated_with"
      donor_type:
        | "individual"
        | "pac"
        | "super_pac"
        | "corporate"
        | "union"
        | "party_committee"
        | "small_donor_aggregate"
        | "other"
      evidence_method: "address_check" | "voter_roll" | "manual_review"
      evidence_outcome: "pending" | "approved" | "rejected" | "inconclusive"
      financial_relationship_type:
        | "donation"
        | "gift"
        | "honorarium"
        | "loan"
        | "owns_stock"
        | "owns_bond"
        | "property"
        | "contract"
        | "grant"
        | "lobbying_spend"
        | "other"
        | "ie_support"
        | "ie_oppose"
      flag_content_type:
        | "civic_comment"
        | "official_community_comment"
        | "entity_comment"
        | "entity_statement"
      flag_reason:
        | "spam"
        | "harassment"
        | "off_topic"
        | "misinformation"
        | "other"
      follow_entity_type: "official" | "agency" | "jurisdiction"
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
        | "committee"
      grant_role: "constituent" | "platform_admin"
      grant_status: "pending" | "active" | "revoked" | "expired"
      grant_target_type: "global" | "jurisdiction"
      initiative_authorship: "individual" | "community"
      initiative_resolution: "sponsored" | "declined" | "withdrawn" | "expired"
      initiative_scope: "federal" | "state" | "local"
      initiative_stage:
        | "draft"
        | "deliberate"
        | "mobilise"
        | "resolved"
        | "problem"
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
        | "school_district"
        | "special_district"
        | "federal_district"
        | "unincorporated_territory"
      notification_event_type:
        | "official_vote"
        | "new_proposal"
        | "initiative_status"
      official_response_type:
        | "support"
        | "oppose"
        | "pledge"
        | "refer"
        | "no_response"
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
      signature_verification: "unverified" | "email" | "district"
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
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {
      argument_flag: ["off_topic", "misleading", "duplicate", "other"],
      argument_side: ["for", "against"],
      connection_type: [
        "donation",
        "vote_yes",
        "vote_no",
        "vote_abstain",
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
        "nomination_vote_yes",
        "nomination_vote_no",
        "holds_position",
        "gift_received",
        "member_of",
        "owns",
        "parent_of",
        "affiliated_with",
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
      evidence_method: ["address_check", "voter_roll", "manual_review"],
      evidence_outcome: ["pending", "approved", "rejected", "inconclusive"],
      financial_relationship_type: [
        "donation",
        "gift",
        "honorarium",
        "loan",
        "owns_stock",
        "owns_bond",
        "property",
        "contract",
        "grant",
        "lobbying_spend",
        "other",
        "ie_support",
        "ie_oppose",
      ],
      flag_content_type: [
        "civic_comment",
        "official_community_comment",
        "entity_comment",
        "entity_statement",
      ],
      flag_reason: [
        "spam",
        "harassment",
        "off_topic",
        "misinformation",
        "other",
      ],
      follow_entity_type: ["official", "agency", "jurisdiction"],
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
        "committee",
      ],
      grant_role: ["constituent", "platform_admin"],
      grant_status: ["pending", "active", "revoked", "expired"],
      grant_target_type: ["global", "jurisdiction"],
      initiative_authorship: ["individual", "community"],
      initiative_resolution: ["sponsored", "declined", "withdrawn", "expired"],
      initiative_scope: ["federal", "state", "local"],
      initiative_stage: [
        "draft",
        "deliberate",
        "mobilise",
        "resolved",
        "problem",
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
        "school_district",
        "special_district",
        "federal_district",
        "unincorporated_territory",
      ],
      notification_event_type: [
        "official_vote",
        "new_proposal",
        "initiative_status",
      ],
      official_response_type: [
        "support",
        "oppose",
        "pledge",
        "refer",
        "no_response",
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
      signature_verification: ["unverified", "email", "district"],
    },
  },
} as const

